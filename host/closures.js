import { assessClosure, discussionsApiPath, isIssueItem } from '../core.js';
import { FOLLOW_UP_MAX_AGE_MS, MAX_DISCUSSION_PAGES } from './constants.js';
import { errorMessage } from './util.js';

/**
 * 闭环裁决：回合结算后核对 GitLab 事实（Todo 是否标记、讨论串是否已回复），
 * 下结论 closed / follow-up / needs-human，并按结论归档。
 * 挂到 GitlabTodoRuntime 原型上，this 指向运行时实例。
 */
export const closuresMethods = {

  /**
   * 回合刚结算后立刻核对闭环：重新拉一次待办列表（此时会话已停，结果不会过期），
   * 再逐条裁决。拉取失败不裁决，记录保持 verifying，留给下一轮轮询处理。
   */
  async verifySettled() {
    if (this.stopping) return;
    const fetchStartedAt = Date.now();
    let todos;
    try {
      todos = await this.fetchTodos();
    } catch (error) {
      this.ctx.logger?.warn?.(`[gitlab-todo-agent] 闭环核对读取 Todo 失败，留待下一轮轮询：${errorMessage(error)}`);
      return;
    }
    this.state.todos = todos;
    if (await this.assessClosures(todos, fetchStartedAt)) await this.persistQuietly('闭环核对');
  },

  /**
   * 初始 pending 的 Todo 已被外部完成：不能重试，也不能让 pending 永远 starting。
   * 未跟踪不等于未接受（响应可能丢失），因此只转“需人工核对”，不直接判定闭环。
   */
  cleanupExternallyDonePending(todos) {
    const pendingIds = new Set(todos.map((todo) => todo.id));
    let changed = false;
    for (const [todoId, pending] of Object.entries(this.state.pending)) {
      // Issue 条目本就不在 GitLab Todo 列表里，缺席不代表被外部完成；否则 pending
      // 会在消息未确认前被误判成“外部已完成”并强制转需人工。
      if (isIssueItem(pending.item)) continue;
      if (pending.followUp === true || pendingIds.has(todoId)) continue;
      if (this.dispatches.has(todoId) || this.isTodoTracked(pending.sessionId, todoId)) continue;
      const existing = this.state.handled[todoId];
      if (existing && !existing.sessionId && existing.outcome !== 'session-accepted') {
        delete this.state.pending[todoId];
        changed = true;
        continue;
      }
      const record = this.materializePendingRecord(todoId, pending);
      record.executionStatus = 'failed';
      record.completedAt = Date.now();
      record.executionError = 'Todo 已在插件外标记完成，但 pending 消息是否已被 Host 接受尚未确认';
      record.closure = 'needs-human';
      record.closureNote = '已停止自动重试以避免重复执行；请人工核对原会话与讨论串后决定是否需要补救';
      record.pendingUnconfirmed = true;
      record.nextAttemptAt = null;
      changed = true;
    }
    return changed;
  },

  /**
   * 闭环裁决。todos 必须是 fetchStartedAt 时刻之后取得的待办列表：
   * - verifying：回合在取数之前就已结束的记录才裁决（取数早于回合结束的列表可能还带着已标记的 Todo）。
   * - follow-up / needs-human：Todo 已从待办列表消失（被续办会话、关联会话或人标记完成）→ 闭环。
   */
  async assessClosures(todos, fetchStartedAt) {
    const pendingIds = new Set(todos.map((todo) => todo.id));
    let changed = this.cleanupExternallyDonePending(todos);
    for (const record of Object.values(this.state.handled)) {
      if (!record?.sessionId || !record.closure) continue;
      if (this.isTodoTracked(record.sessionId, record.id) || this.dispatches.has(record.id)) continue;
      if (record.closure === 'closed') {
        // 共享会话此前因其他任务未结算而跳过归档：这里每轮补偿重试，
        // 否则首条非 routed 记录 closed 后会永远失去归档机会。
        const before = `${record.archived}|${record.archiveError}`;
        await this.archiveRecord(record);
        if (before !== `${record.archived}|${record.archiveError}`) changed = true;
        continue;
      }
      const issue = isIssueItem(record.item);
      const todoPending = pendingIds.has(record.id);
      // Issue 闭环事实：只认“Issue 已关闭”——证明为 true 才算 closed，
      // 其余（仍开放、不可判定）一律按“仍开放”保守处理。
      const issueClosed = issue ? await this.issueIsClosed(record.item) : null;
      const targetOpen = issue ? issueClosed !== true : todoPending;
      if (record.closure === 'verifying') {
        if ((record.completedAt ?? 0) > fetchStartedAt) continue;
        if (issue && issueClosed === null) continue;
        await this.concludeRecord(record, targetOpen);
        changed = true;
      } else if (!targetOpen && record.replied !== false && record.pendingUnconfirmed !== true) {
        record.closure = 'closed';
        record.closureNote = issue ? 'Issue 已关闭' : 'Todo 已不在待办列表（已被标记完成）';
        record.nextAttemptAt = null;
        record.watch = null;
        await this.archiveRecord(record);
        changed = true;
      }
    }
    return changed;
  },

  /** 对一条刚结算的记录下闭环结论，并按结论归档。 */
  async concludeRecord(record, todoPending) {
    const settings = this.state.settings;
    const item = record.item ?? this.state.todos.find((todo) => todo.id === record.id)
      ?? (Array.isArray(this.state.issues) ? this.state.issues.find((todo) => todo.id === record.id) : null)
      ?? null;
    const issue = isIssueItem(item);
    // 会话判定为“仅被提及”且 Todo 已标记完成：本就不该回复，不核对讨论串。
    const mentionOnly = record.reportNoAction === true && !todoPending;
    // since 留 120 秒余量：本机时钟快于 GitLab 时，本轮回复的 created_at 可能早于派发时间。
    const replyInfo = item?.noteId && !mentionOnly
      ? await this.checkThreadReply(item, (record.acceptedAt ?? 0) - 120_000)
      : null;
    const replied = replyInfo ? replyInfo.replied : null;
    const round = record.round ?? 1;
    // 纯等待轮（自述 waiting、回合正常、无缺回复证据）不消耗轮数预算，只受总时限约束；
    // 补救轮（回合失败、漏回复、漏标记）才计入 maxFollowUps。
    const cleanWait = record.reportStatus === 'waiting' && record.executionStatus === 'completed' && replied !== false;
    const waitRounds = Number.isSafeInteger(record.waitRounds) && record.waitRounds >= 0 ? record.waitRounds : 0;
    const actionRounds = Math.max(0, round - waitRounds - (cleanWait ? 1 : 0));
    let followUpBlocked = '';
    if (record.automatic === false) followUpBlocked = '手动派发的会话不自动续办';
    else if (settings.followUpEnabled === false) followUpBlocked = '自动续办未开启';
    else if (actionRounds > settings.maxFollowUps) followUpBlocked = `已达自动补救轮数上限（补救 ${actionRounds} 轮）`;
    else if (Date.now() - (record.firstAcceptedAt ?? record.acceptedAt) > FOLLOW_UP_MAX_AGE_MS) followUpBlocked = '超出自动续办时限';
    else if (!item) followUpBlocked = '缺少 Todo 数据，无法续办';
    const verdict = assessClosure({
      todoPending,
      replied,
      turnOk: record.executionStatus === 'completed',
      turnError: record.executionError,
      report: record.reportStatus
        ? { status: record.reportStatus, summary: record.reportSummary, resumeAfterMinutes: record.resumeAfterMinutes }
        : null,
      round,
      followUpBlocked,
      baseDelayMinutes: settings.followUpDelayMinutes,
      unit: issue ? 'issue' : 'todo',
    });
    record.replied = replied;
    if (cleanWait) record.waitRounds = waitRounds + 1;
    // 本轮有新的我方回复时更新快照（面板回复预览/收件箱展示）；本轮没回复保留旧值。
    if (replyInfo?.reply) record.lastReply = replyInfo.reply;
    if (mentionOnly && verdict.closure === 'closed') verdict.note = `仅被提及，无需处理：${record.reportSummary || '会话判定无行动要求'}`.slice(0, 500);
    record.closure = verdict.closure;
    record.closureNote = verdict.note;
    record.nextAttemptAt = verdict.closure === 'follow-up' ? Date.now() + verdict.delayMinutes * 60000 : null;
    // 事件驱动续办：waiting 且挂着未合并 MR 时建立监视器（MR 状态翻转提前续办，定时器兜底）。
    record.watch = null;
    if (verdict.closure === 'follow-up' && record.reportStatus === 'waiting'
      && Array.isArray(record.openMrs) && record.openMrs.length > 0) {
      record.watch = { mrs: record.openMrs.slice(0, 3), lastStates: {} };
    }
    // 需人工接手的会话保留不归档，方便人直接打开接着做；闭环或已排续办的才归档。
    if (verdict.closure !== 'needs-human') await this.archiveRecord(record);
  },

  /** 归档一条记录的会话：路由目标不归档；共享会话还有其他任务时也不归档。 */
  async archiveRecord(record) {
    if (!record?.sessionId || record.archived || record.routed === true) return;
    if (record.executionStatus !== 'completed' || this.state.settings.autoArchive === false) return;
    const tracked = this.trackedSessions.get(record.sessionId);
    if ([...tracked?.todos.keys() ?? []].some((todoId) => todoId !== record.id)) return;
    if (Object.values(this.state.pending).some((pending) => pending.sessionId === record.sessionId && pending.item?.id !== record.id)) return;
    try {
      await this.host.archiveSession(record.sessionId);
      record.archived = true;
      record.archiveError = '';
    } catch (archiveError) {
      // 归档失败不影响闭环结论；仍有工作在跑等拒绝只记录原因，不强行停止任何工作。
      record.archiveError = errorMessage(archiveError);
      this.ctx.logger?.warn?.(`[gitlab-todo-agent] 归档会话 ${record.sessionId} 失败：${record.archiveError}`);
    }
  },

  /**
   * 核对原 note 所在讨论串里、原 note 之后是否有我方账号的回复，并取回本轮最新一条我方回复。
   * replied true/false 为确定结论；返回 null 为无法判断（目标类型不支持、接口失败、没找到讨论串），按未知处理。
   * reply 只取 created_at 不早于 since（本轮派发时间）的最新一条；本轮没有新回复时为 null，
   * 由调用方保留记录上已有的快照。
   */
  async checkThreadReply(item, since = 0) {
    const api = discussionsApiPath(item?.url);
    if (!api || !item?.noteId || !this.gitlabUserId) return null;
    const baseUrl = String(item.url ?? '').split('#')[0];
    const capture = (note) => ({
      id: String(note.id ?? ''),
      body: String(note.body ?? '').trim().slice(0, 2000),
      url: baseUrl ? `${baseUrl}#note_${note.id}` : '',
      createdAt: Date.parse(note.created_at ?? '') || null,
    });
    try {
      for (let page = 1; page <= MAX_DISCUSSION_PAGES; page += 1) {
        const stdout = await this.runGlab(['api', '-X', 'GET', api, '-F', 'per_page=100', '-F', `page=${page}`, '-F', 'order_by=updated_at', '-F', 'sort=desc']);
        const discussions = JSON.parse(stdout);
        if (!Array.isArray(discussions)) return null;
        for (const discussion of discussions) {
          const notes = Array.isArray(discussion?.notes) ? discussion.notes : [];
          const index = notes.findIndex((note) => String(note?.id) === item.noteId);
          if (index < 0) continue;
          const ours = notes.slice(index + 1).filter((note) => note
            && note.system !== true
            && String(note.author?.id ?? '') === this.gitlabUserId);
          if (ours.length === 0) return { replied: false, reply: null };
          // 时间解析失败的 note 视为本轮产物（保守捕获，宁可多取不可漏取）。
          const fresh = ours.filter((note) => {
            const at = Date.parse(note.created_at ?? '');
            return !Number.isFinite(since) || !Number.isFinite(at) || at >= since;
          });
          const chosen = fresh.length > 0 ? fresh[fresh.length - 1] : null;
          return { replied: true, reply: chosen ? capture(chosen) : null };
        }
        if (discussions.length < 100) break;
      }
    } catch (error) {
      // 闭环判定的关键证据拿不到时必须留痕，否则“回复未核对”无从排查。
      this.ctx.logger?.warn?.(`[gitlab-todo-agent] 核对讨论串回复失败（${api}）：${errorMessage(error)}`);
      return null;
    }
    return null;
  },
};
