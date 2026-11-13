import { randomUUID } from 'node:crypto';
import {
  buildIssuePrompt,
  buildSessionTitle,
  buildTodoPrompt,
  buildWorkspaceOverview,
  classifyTodo,
  DEFAULT_SIGNATURE_TEXT,
  findRouteTargets,
  isIssueItem,
  normalizeMrUrls,
  normalizeWorkspacePath,
  pruneHandled,
  selectPendingTodos,
  targetKey,
} from '../core.js';
import {
  FOLLOW_UP_MAX_AGE_MS,
  FOLLOW_UP_MAX_DISPATCH_FAILURES,
  FOLLOW_UP_RETRY_MS,
  MAX_RULE_SKIPS_PER_POLL,
  MAX_SESSION_REUSE,
  RULE_SKIP_REASONS,
  WAIT_BUDGET_MINUTES,
} from './constants.js';
import { errorMessage, sessionSummaryTitle } from './util.js';

/**
 * 派发管线与面板动作：轮询编排（规则跳过 → 预检 → 入队 → 泵）、
 * dispatch 幂等去重、会话路由（手动/自动/续办复用）、手动动作、工作区总览。
 * 挂到 GitlabTodoRuntime 原型上，this 指向运行时实例。
 */
export const dispatchMethods = {

  enqueueDispatch(todos) {
    if (!Array.isArray(todos) || todos.length === 0) return;
    const queued = new Set(this.dispatchQueue.map((entry) => entry.todo.id));
    for (const todo of todos) {
      if (queued.has(todo.id) || this.dispatches.has(todo.id) || this.state.handled[todo.id]) continue;
      this.dispatchQueue.push({ todo, followUp: false });
    }
    this.ensureSessionTimer();
  },

  pump() {
    if (this.pumpPromise) return this.pumpPromise;
    const operation = this.executePump().finally(() => {
      if (this.pumpPromise === operation) this.pumpPromise = null;
    });
    this.pumpPromise = operation;
    return operation;
  },

  async executePump() {
    while (!this.stopping && this.dispatchQueue.length > 0) {
      if (!this.hasFreeSlot()) {
        void this.reconcileSessions();
        await this.waitForSlotSignal();
        continue;
      }
      const { todo, followUp, pendingRetry } = this.dispatchQueue.shift();
      if (pendingRetry) {
        if (!this.state.pending[todo.id]) continue;
        await this.dispatch(todo, Boolean(this.state.handled[todo.id]), { trackSlot: true, followUp });
        continue;
      }
      if (followUp) {
        // 排队期间可能已被别的会话或人闭环；只有仍处于待续办的才真正开续办会话。
        if (this.state.handled[todo.id]?.closure !== 'follow-up') continue;
        await this.dispatch(todo, true, { trackSlot: true, followUp: true });
        continue;
      }
      if (this.state.handled[todo.id]) continue;
      await this.dispatch(todo, false, { trackSlot: true });
    }
  },

  async poll(source = 'manual') {
    if (this.pollPromise) return this.pollPromise;
    const operation = this.executePoll(source).finally(() => {
      if (this.pollPromise === operation) this.pollPromise = null;
    });
    this.pollPromise = operation;
    return operation;
  },

  async executePoll(source) {
    const pruned = pruneHandled(this.state.handled).deleted;
    if (pruned.length > 0) {
      for (const id of pruned) delete this.state.handled[id];
      this.ctx.logger?.info?.(`[gitlab-todo-agent] 清理 handled 历史记录 ${pruned.length} 条。`);
    }
    if (this.stopping) return this.snapshot();
    this.state.lastRunAt = Date.now();
    this.state.lastPollError = null;
    try {
      const fetchStartedAt = Date.now();
      const todos = await this.fetchTodos();
      this.state.todos = todos;
      this.state.lastSuccessAt = Date.now();
      // 闭环核对不依赖自动处理开关：它只更新记录状态和归档，不会开新会话。
      await this.assessClosures(todos, fetchStartedAt);
      const candidates = selectPendingTodos(todos, this.state.handled, todos.length)
        .filter((todo) => !this.dispatches.has(todo.id) && !this.state.pending[todo.id]);
      this.state.lastNewCount = candidates.length;
      if (this.state.settings.enabled) {
        // 上轮残留的预检判定：Todo 已由其他路径出结果时清掉，避免派发时误用。
        for (const todoId of [...this.judgeVerdicts.keys()]) {
          const handled = this.state.handled[todoId];
          if (handled && (!handled.sessionId || handled.outcome !== 'session-accepted')) this.judgeVerdicts.delete(todoId);
        }
        // 0) 事件驱动续办：waiting 记录监视的 MR 状态翻转即把续办提前到本轮；定时器仍作兜底。
        if (this.state.settings.followUpEnabled !== false) await this.refreshWatches();
        // 0.1) 到期的续办先入队：先把已经开了头的事收尾，再开新的。
        if (this.state.settings.followUpEnabled !== false) {
          await this.probeWaitingFollowUps();
          this.enqueueFollowUps();
        }
        // 0.1) pending 是可能已被 Host 接受的消息：不参与下面的二次预检，但必须自动重试。
        this.enqueuePendingRetries();
        // 1) 规则跳过：流水线通知、自己 @ 自己——零模型调用，程序内直接标记完成。
        if (this.state.settings.ruleSkipEnabled !== false) {
          const classified = new Map(candidates.map((todo) => [todo.id, classifyTodo(todo, this.gitlabUserId)]));
          const noise = candidates
            .filter((todo) => RULE_SKIP_REASONS[classified.get(todo.id)])
            .slice(0, MAX_RULE_SKIPS_PER_POLL);
          for (const todo of noise) {
            try {
              await this.markTodoDone(todo);
              this.state.handled[todo.id] = {
                id: todo.id,
                sessionId: null,
                outcome: 'rule-skipped',
                automatic: true,
                acceptedAt: Date.now(),
                skipReason: RULE_SKIP_REASONS[classified.get(todo.id)],
                title: todo.title,
                url: todo.url,
                project: todo.project,
              };
            } catch (error) {
              this.ctx.logger?.warn?.(`[gitlab-todo-agent] 规则跳过 Todo ${todo.id} 标记完成失败：${errorMessage(error)}`);
            }
          }
        }
        // 2) LLM 批量预检：一次判定本批全部提及（优先级/重复/类型/路由倾向），
        //    批量解析失败自动退回逐条预检；只有判定需要处理的 Todo 进入派发队列。
        let mentions = candidates
          .filter((todo) => !this.state.handled[todo.id] && classifyTodo(todo, this.gitlabUserId) === 'direct-mention')
          .slice(0, this.state.settings.maxSessionsPerPoll);
        if (this.state.settings.precheckEnabled && mentions.length > 0) {
          mentions = await this.precheckMentions(mentions);
        }
        this.enqueueDispatch(mentions);
        void this.pump();
      }
    } catch (error) {
      this.state.lastPollError = `轮询失败：${errorMessage(error)}`;
      this.ctx.logger?.warn?.(`[gitlab-todo-agent] ${this.state.lastPollError}`);
    } finally {
      await this.persistQuietly('轮询');
    }
    return this.snapshot();
  },

  resolveWorkspaceId() {
    const items = this.ctx.workspaceRegistry?.list?.() ?? [];
    const configured = this.state.settings.sessionCwd;
    if (configured) {
      const match = items.find((item) => normalizeWorkspacePath(item.path ?? item.cwd) === normalizeWorkspacePath(configured));
      if (match?.id) return match.id;
      throw new Error(`配置的工作区文件夹未在 DSH 工作区中注册：${configured}`);
    }
    let best;
    let bestAt = Number.NEGATIVE_INFINITY;
    for (const item of items) {
      const at = Date.parse(item.updatedAt);
      if (Number.isFinite(at) && at > bestAt) {
        best = item;
        bestAt = at;
      }
    }
    const workspaceId = best?.id ?? items[0]?.id;
    if (!workspaceId) throw new Error('DSH 尚未注册工作区，请先创建或选择一个工作区。');
    return workspaceId;
  },

  /** 插件自己派发过的会话（handled + pending），供工作区总览打标。 */
  pluginSessionRecords() {
    const records = [];
    for (const record of Object.values(this.state.handled)) {
      if (!record?.sessionId) continue;
      records.push({
        sessionId: record.sessionId,
        sessionTitle: record.sessionTitle,
        automatic: record.automatic !== false,
        archived: record.archived === true,
        url: record.url,
      });
    }
    for (const record of Object.values(this.state.pending)) {
      if (!record?.sessionId) continue;
      records.push({
        sessionId: record.sessionId,
        sessionTitle: '',
        automatic: record.automatic !== false,
        archived: false,
        url: record.item?.url ?? '',
      });
    }
    return records;
  },

  /**
   * 当前 dsh-desktop 的工作区总览：工作区（含权威 sessionIds 归属）
   * join session/list 名册（运行状态），并给插件会话打标。
   * 名册不可用时降级为只展示结构（known=false），不抛错。
   */
  async workspaceOverview() {
    const workspaces = this.ctx.workspaceRegistry?.list?.() ?? [];
    let roster = [];
    try {
      const value = await this.host.listSessions();
      if (Array.isArray(value?.items)) roster = value.items;
    } catch {
      roster = [];
    }
    return buildWorkspaceOverview(workspaces, roster, this.pluginSessionRecords(), this.state.settings.sessionCwd);
  },

  /**
   * 按 id 找任务条目：先查本轮 Todo，再查 Issue 面板缓存（合成 id `issue-*`），
   * 最后回落到 handled/pending 里保存的 item 快照（列表刷新后仍可重新处理）。
   */
  itemById(id) {
    const key = String(id ?? '');
    if (!key) return null;
    const direct = this.state.todos.find((item) => item.id === key)
      ?? (Array.isArray(this.state.issues) ? this.state.issues.find((item) => item.id === key) : null);
    if (direct) return direct;
    return this.state.handled[key]?.item ?? this.state.pending[key]?.item ?? null;
  },

  async dispatchById(id) {
    const todo = this.itemById(id);
    if (!todo) return { ok: false, error: '当前列表中找不到该对象，请刷新后重试。' };
    return this.dispatch(todo, Boolean(this.state.handled[id]));
  },

  async routeById(id, sessionId) {
    const todo = this.itemById(id);
    if (!todo) return { ok: false, error: '当前列表中找不到该对象，请刷新后重试。' };
    if (typeof sessionId !== 'string' || !sessionId.trim()) return { ok: false, error: '缺少目标 sessionId。' };
    return this.dispatch(todo, Boolean(this.state.handled[id]), { route: { sessionId: sessionId.trim() } });
  },

  /** 插件真正创建过的会话；仅接收过路由消息的外部会话不算。 */
  pluginCreatedSessionIds() {
    const ids = new Set();
    for (const record of Object.values(this.state.handled)) {
      if (record?.sessionId && record.routed !== true) ids.add(record.sessionId);
      for (const entry of record?.history ?? []) if (entry?.sessionId && entry.routed !== true) ids.add(entry.sessionId);
    }
    for (const record of Object.values(this.state.pending)) {
      if (record?.sessionId && record.routed !== true) ids.add(record.sessionId);
      for (const entry of record?.history ?? []) if (entry?.sessionId && entry.routed !== true) ids.add(entry.sessionId);
    }
    return ids;
  },

  archivedSessionIds() {
    const ids = new Set();
    const raw = this.ctx.workspaceRegistry?.archivedSessionIds;
    try {
      const values = raw && typeof raw.list === 'function' ? raw.list() : raw;
      if (values && typeof values[Symbol.iterator] === 'function') {
        for (const id of values) if (typeof id === 'string') ids.add(id);
      }
    } catch {
      // 归档名册读取失败不影响主流程，但留一条调试日志便于排查“外部归档过滤失效”。
      this.ctx.logger?.debug?.('[gitlab-todo-agent] 读取工作区归档会话列表失败，跳过外部归档过滤。');
    }
    for (const record of Object.values(this.state.handled)) {
      if (record?.sessionId && record.archived === true) ids.add(record.sessionId);
      for (const entry of record?.history ?? []) {
        if (entry?.sessionId && entry.archived === true) ids.add(entry.sessionId);
      }
    }
    for (const record of Object.values(this.state.pending)) {
      for (const entry of record?.history ?? []) {
        if (entry?.sessionId && entry.archived === true) ids.add(entry.sessionId);
      }
    }
    return ids;
  },

  /** 手动路由选择器数据。只列可投递的顶层会话，并附带负载与同目标标记。 */
  async routeTargets(todoId = '') {
    const value = await this.host.listSessions();
    if (!Array.isArray(value?.items)) throw new Error('session/list 响应缺少 items 数组。');
    const owned = this.pluginCreatedSessionIds();
    const archived = this.archivedSessionIds();
    const scope = this.state.settings.routeScope;
    // Todo 与 Issue 面板条目都可以发起路由：按同一 id 空间查找。
    const todo = this.itemById(todoId);
    const key = targetKey(todo?.url);
    const recordsBySession = new Map();
    for (const record of Object.values(this.state.handled)) {
      if (!record?.sessionId) continue;
      const previous = recordsBySession.get(record.sessionId);
      if (!previous || (record.acceptedAt ?? 0) > (previous.acceptedAt ?? 0)) recordsBySession.set(record.sessionId, record);
    }
    const maxQueue = this.state.settings.maxQueuePerSession;
    const items = value.items
      .filter((summary) => summary?.sessionId
        && summary.blank !== true
        && summary.isSubagent !== true
        && summary.origin !== 'subagent'
        && !summary.parentSessionId
        && summary.archived !== true
        && !archived.has(String(summary.sessionId))
        && (scope === 'any' || owned.has(String(summary.sessionId))))
      .map((summary) => {
        const sessionId = String(summary.sessionId);
        const record = recordsBySession.get(sessionId);
        const load = this.countSessionLoad(sessionId);
        return {
          sessionId,
          title: sessionSummaryTitle(summary) || String(record?.sessionTitle || '未命名会话'),
          running: summary.running === true,
          updatedAt: Number.isFinite(summary.updatedAt) ? summary.updatedAt : null,
          cwd: typeof summary.cwd === 'string' ? summary.cwd : '',
          plugin: owned.has(sessionId),
          sameTarget: Boolean(key) && targetKey(record?.url) === key,
          load,
          accepting: load < maxQueue,
        };
      })
      .sort((a, b) => Number(b.sameTarget) - Number(a.sameTarget) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, 200);
    return { scope, busyRouteMode: this.state.settings.busyRouteMode, maxQueuePerSession: maxQueue, items };
  },

  /**
   * 校验并解析路由目标。手动选择失败时明确报错；自动路由失败返回 null，退回新会话。
   * 忙碌目标按 busyRouteMode 选择 queue/steer，空闲目标总是 queue（立即开始新回合）。
   */
  async resolveRouteTarget(todo, target, manual = false) {
    const sessionId = typeof target?.sessionId === 'string' ? target.sessionId : '';
    const fail = (message) => {
      if (manual) throw new Error(message);
      return null;
    };
    if (!sessionId) return fail('缺少路由目标 sessionId。');
    const value = await this.host.listSessions();
    const summary = Array.isArray(value?.items) ? value.items.find((item) => String(item?.sessionId) === sessionId) : null;
    if (!summary) return fail(`目标会话 ${sessionId} 已不存在，未投递。`);
    if (summary.blank === true || summary.isSubagent === true || summary.origin === 'subagent' || summary.parentSessionId) {
      return fail('空白会话和子代理会话不能作为路由目标。');
    }
    if (summary.archived === true || this.archivedSessionIds().has(sessionId)) {
      return fail(`目标会话 ${sessionId} 已归档，未投递。`);
    }
    if (this.state.settings.routeScope !== 'any' && !this.pluginCreatedSessionIds().has(sessionId)) {
      return fail('当前路由范围仅允许插件创建过的会话；可在设置中改为任意会话。');
    }
    const load = this.countSessionLoad(sessionId, todo?.id);
    const maxQueue = this.state.settings.maxQueuePerSession;
    if (load >= maxQueue) return fail(`目标会话已有 ${load} 条未结算任务，达到单会话上限 ${maxQueue}。`);
    const running = summary.running === true;
    return {
      sessionId,
      mode: running ? this.state.settings.busyRouteMode : 'queue',
      title: sessionSummaryTitle(summary) || String(target?.record?.sessionTitle || sessionId),
    };
  },

  /**
   * 续办复用：上一轮会话仍可接力时返回 { sessionId }，否则返回 null（调用方新开会话）。
   * 条件：开关打开、上一轮是插件自己创建的自动会话且回合正常结束、会话仍存在且空闲、
   * 没有其他未结算任务挂在上面、复用次数未达上限。已归档的会话先取消归档（失败则放弃复用）。
   */
  async pickReusableSession(previous, todo) {
    if (this.state.settings.followUpReuseSession === false) return null;
    if (!previous?.sessionId || previous.automatic === false || previous.routed === true) return null;
    if (previous.executionStatus !== 'completed') return null;
    const reuseCount = Number.isSafeInteger(previous.reuseCount) ? previous.reuseCount : 0;
    if (reuseCount >= MAX_SESSION_REUSE) return null;
    const sessionId = previous.sessionId;
    if (this.trackedSessions.has(sessionId) && this.countSessionLoad(sessionId, todo?.id) > 0) return null;
    const value = await this.host.listSessions();
    const summary = Array.isArray(value?.items) ? value.items.find((entry) => String(entry?.sessionId) === sessionId) : null;
    if (!summary || summary.running === true) return null;
    if (summary.blank === true || summary.isSubagent === true || summary.origin === 'subagent' || summary.parentSessionId) return null;
    if (summary.archived === true || previous.archived === true) {
      try {
        await this.host.unarchiveSession(sessionId);
      } catch (error) {
        this.ctx.logger?.warn?.(`[gitlab-todo-agent] 取消归档会话 ${sessionId} 失败，续办改为新开会话：${errorMessage(error)}`);
        return null;
      }
      previous.archived = false;
      previous.archiveError = '';
    }
    return { sessionId, title: sessionSummaryTitle(summary) };
  },

  /** 同一对象上、由插件会话处理过但仍未闭环（Todo 仍在待办列表）的其他 Todo。 */
  relatedOpenTodos(todo) {
    const key = targetKey(todo?.url);
    if (!key) return [];
    const pendingIds = new Set(this.state.todos.map((item) => item.id));
    return Object.values(this.state.handled)
      .filter((record) => record.id !== todo.id
        && record.sessionId
        && (record.closure === 'needs-human' || record.closure === 'follow-up')
        && pendingIds.has(record.id)
        && targetKey(record.url) === key)
      .slice(0, 5)
      .map((record) => ({
        todoId: record.id,
        url: record.url,
        note: record.closureNote,
        openMrs: Array.isArray(record.openMrs) ? record.openMrs : [],
      }));
  },

  async dispatch(todo, force = false, options = {}) {
    const existingSessionId = this.state.handled[todo.id]?.sessionId ?? this.state.pending[todo.id]?.sessionId;
    if (force && existingSessionId && this.isTodoTracked(existingSessionId, todo.id)) {
      return { ok: false, error: '该 Todo 的 Session 仍在执行，请等待当前执行结束后再重新处理。' };
    }
    if (!force && this.state.handled[todo.id]) {
      return { ok: true, sessionId: this.state.handled[todo.id].sessionId, duplicate: true };
    }
    if (this.dispatches.has(todo.id)) return this.dispatches.get(todo.id);
    const operation = this.executeDispatch(todo, force, options).finally(() => {
      if (this.dispatches.get(todo.id) === operation) this.dispatches.delete(todo.id);
    });
    this.dispatches.set(todo.id, operation);
    return operation;
  },

  /**
   * 手动切换一个插件会话的归档状态（面板“最近会话”快捷操作）。
   * 只作用于插件自己派发过的会话；归档仍在执行的会话会被 Host 拒绝，原样把错误带回去。
   */
  async setSessionArchived(sessionId, archived) {
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, error: '缺少 sessionId。' };
    if (typeof archived !== 'boolean') return { ok: false, error: 'archived 必须是布尔值。' };
    let record = null;
    let historyEntry = null;
    for (const item of Object.values(this.state.handled)) {
      if (item?.sessionId === sessionId && item.routed !== true) {
        record = item;
        break;
      }
      const entry = item?.history?.find((candidate) => candidate.sessionId === sessionId && candidate.routed !== true);
      if (entry) {
        record = item;
        historyEntry = entry;
        break;
      }
    }
    if (!record) return { ok: false, error: '该会话不是插件创建的会话。' };
    const archiveState = historyEntry ?? record;
    if (archived && this.trackedSessions.has(sessionId)) {
      return { ok: false, error: '会话仍在执行，结算后再变更归档状态。' };
    }
    try {
      if (archived) await this.host.archiveSession(sessionId);
      else await this.host.unarchiveSession(sessionId);
      archiveState.archived = archived;
      if (archived) archiveState.archiveError = '';
      await this.persistQuietly('会话归档状态');
      return { ok: true };
    } catch (error) {
      if (archived) archiveState.archiveError = errorMessage(error);
      await this.persistQuietly('会话归档状态');
      throw error;
    }
  },

  /**
   * 收件箱“我已处理”：人工确认一条 needs-human 记录——尽力把 Todo 标记完成、
   * 记录确认时间（收件箱据此移出）、闭环并按设置归档会话。
   * 标记完成失败不阻塞确认，原因写进结论。
   */
  async acknowledgeNeedsHuman(todoId) {
    const record = this.state.handled[String(todoId ?? '')];
    if (!record?.sessionId || record.closure !== 'needs-human') {
      return { ok: false, error: '该 Todo 不在需人工收件箱中。' };
    }
    const item = record.item ?? this.state.todos.find((todo) => todo.id === record.id) ?? null;
    let note = '人工确认已处理';
    // Issue 记录没有对应 GitLab Todo，mark_as_done 必然 404；人工确认只做状态与归档处理。
    if (item && !isIssueItem(item)) {
      try {
        await this.markTodoDone(item);
      } catch (error) {
        note = `人工确认已处理（标记完成失败：${errorMessage(error).slice(0, 200)}）`;
      }
    }
    record.acknowledgedAt = Date.now();
    record.closure = 'closed';
    record.closureNote = note;
    record.nextAttemptAt = null;
    record.watch = null;
    record.pendingUnconfirmed = false;
    await this.archiveRecord(record);
    // 回合异常结束的会话不会被自动归档：把这一情况写进结论，提示去“最近会话”手动处理。
    if (record.archived !== true && record.executionStatus !== 'completed') {
      record.closureNote = `${note}（会话回合异常未归档，可在最近会话手动归档）`.slice(0, 500);
    }
    await this.persistQuietly('人工确认');
    this.wakeWaiters();
    return { ok: true };
  },

  async executeDispatch(todo, force, options = {}) {
    const trackSlot = Boolean(options.trackSlot);
    const followUp = Boolean(options.followUp);
    const pending = this.state.pending[todo.id];
    // 批量预检判定：仅“首次自动派发”形态（trackSlot 且非重试/续办/手动/路由）消费；
    // 其余形态直接丢弃，避免手动会话被换成任务类型模型。派发即消费，不重复使用旧判定。
    const verdictEligible = trackSlot && !force && !followUp && !pending && !options.route;
    const judge = verdictEligible ? (this.judgeVerdicts.get(todo.id) ?? null) : null;
    this.judgeVerdicts.delete(todo.id);
    // pending 代表可能已被 Host 接受的消息；无论是否 force，都只能复用原会话与 requestId。
    let sessionId = options.route ? null : (pending?.sessionId ?? null);
    let route = null;
    // 续办会话复用：接力上一轮的同一会话（见 pickReusableSession）。
    let reuse = null;
    // 同一 Todo 已有过会话再开新会话（自动续办或手动重新处理）：延续链路，轮次 +1。
    const previous = this.state.handled[todo.id];
    const continuing = Boolean(force && previous?.sessionId);
    const round = continuing ? (previous.round ?? 1) + 1 : 1;
    const firstAcceptedAt = continuing ? (previous.firstAcceptedAt ?? previous.acceptedAt) : Date.now();
    const history = continuing
      ? [...(Array.isArray(previous.history) ? previous.history : []), {
          sessionId: previous.sessionId,
          sessionTitle: previous.sessionTitle ?? '',
          routed: previous.routed === true,
          archived: previous.archived === true,
          round: previous.round ?? 1,
          endedAt: previous.completedAt ?? null,
          status: previous.reportStatus || previous.executionStatus || '',
          note: previous.closureNote || previous.reportSummary || previous.executionError || '',
        }].slice(-10)
      : [];
    const ownMrs = continuing && Array.isArray(previous.openMrs) ? previous.openMrs : [];
    const sessionTitle = buildSessionTitle(todo, round);
    let routedTitle = '';
    let reserved = false;
    try {
      const kind = classifyTodo(todo, this.gitlabUserId);
      if (kind === 'merge-request' || kind === 'assignment-notify') {
        await this.markTodoDone(todo);
        const record = {
          id: todo.id,
          sessionId: null,
          outcome: kind === 'assignment-notify' ? 'rule-skipped' : 'merge-request-done',
          acceptedAt: Date.now(),
          skipReason: kind === 'assignment-notify' ? RULE_SKIP_REASONS['assignment-notify'] : '',
          title: todo.title,
          url: todo.url,
          project: todo.project,
        };
        this.state.handled[todo.id] = record;
        delete this.state.pending[todo.id];
        this.state.lastDispatchError = null;
        await this.persistQuietly('MR 直接完成');
        return { ok: true, sessionId: null, duplicate: false, skipped: true };
      }
      if (pending && !pending.requestId) {
        throw new Error('该 Todo 有旧版本留下的 pending 消息，缺少可用于幂等重试的 requestId。为避免重复执行，本次未重新投递；请先让插件完成原会话核对，无法确认时会转为需人工。');
      }
      if (options.route && pending && pending.sessionId !== options.route.sessionId) {
        throw new Error(`该 Todo 已有一条待确认消息在会话 ${pending.sessionId}（requestId: ${pending.requestId || '旧版无标识'}）。为避免重复执行，不能改投会话 ${options.route.sessionId}；请先选择原会话重试或等待其结算。`);
      }
      if (pending?.routed === true) {
        // 上次路由提示词可能已送达但响应丢失：沿用目标与 requestId，让 Host 幂等去重。
        route = { sessionId: pending.sessionId, mode: pending.routeMode || 'queue', title: pending.sessionTitle ?? '' };
        sessionId = pending.sessionId;
      } else if (options.route) {
        if (pending) {
          // 同一会话的 pending 新会话也按原路径重试，不能改记成 routed 或换 requestId。
          sessionId = pending.sessionId;
        } else {
          route = await this.resolveRouteTarget(todo, options.route, true);
          sessionId = route.sessionId;
        }
      } else if (followUp && !pending && continuing) {
        // 自动续办优先接力上一轮的会话：省掉新会话的冷启动与重新摸索；不满足条件时退回新开会话。
        reuse = await this.pickReusableSession(previous, todo).catch((reuseError) => {
          this.ctx.logger?.warn?.(`[gitlab-todo-agent] 续办复用会话检查失败，改为新开会话：${errorMessage(reuseError)}`);
          return null;
        });
        if (reuse) {
          sessionId = reuse.sessionId;
          for (const entry of history) if (entry.sessionId === sessionId) entry.archived = false;
        }
      } else if (trackSlot && !force && !followUp && !pending && this.state.settings.autoRoute && judge?.preferSession !== 'new') {
        // 预检判定“虽同对象但主题无关”（preferSession=new）时不复用旧会话；
        // 候选按新到旧逐个过宿主校验（存在性/外部归档/负载）：最新的失败不排除次新可用者。
        for (const candidate of findRouteTargets(this.state.handled, todo, {
          loadOf: (id) => this.countSessionLoad(id),
          maxQueue: this.state.settings.maxQueuePerSession,
        })) {
          route = await this.resolveRouteTarget(todo, candidate, false);
          if (route) {
            sessionId = route.sessionId;
            break;
          }
        }
      }
      if (route) routedTitle = route.title || sessionTitle;
      const effectiveTitle = route ? routedTitle : (reuse ? (previous.sessionTitle || sessionTitle) : sessionTitle);
      const reused = Boolean(reuse) || pending?.reused === true;
      const reuseCount = reuse
        ? (Number.isSafeInteger(previous.reuseCount) ? previous.reuseCount : 0) + 1
        : (pending?.reused === true && Number.isSafeInteger(pending.reuseCount) ? pending.reuseCount : 0);
      const requestId = pending && pending.sessionId === sessionId && pending.requestId
        ? pending.requestId
        : `gitlab-todo-${randomUUID()}`;
      const promptStartedAt = pending && pending.sessionId === sessionId && Number.isFinite(pending.createdAt)
        ? pending.createdAt
        : Date.now();
      if (trackSlot && !route) {
        this.reserveSlot();
        reserved = true;
      }
      if (sessionId) {
        this.trackSession(sessionId, todo.id, promptStartedAt, trackSlot, requestId);
      }
      if (route) {
        this.state.pending[todo.id] = {
          sessionId,
          createdAt: promptStartedAt,
          automatic: trackSlot,
          followUp,
          routed: true,
          routeMode: route.mode,
          requestId,
          round,
          firstAcceptedAt,
          history,
          openMrs: [...ownMrs],
          sessionTitle: effectiveTitle,
          item: todo,
        };
        await this.persistQuietly('pending 路由消息');
      }
      if (reuse) {
        this.state.pending[todo.id] = {
          sessionId,
          createdAt: promptStartedAt,
          automatic: trackSlot,
          followUp,
          routed: false,
          reused: true,
          reuseCount,
          requestId,
          round,
          firstAcceptedAt,
          history,
          openMrs: [...ownMrs],
          waitRounds: Number.isSafeInteger(previous.waitRounds) ? previous.waitRounds : 0,
          sessionTitle: effectiveTitle,
          item: todo,
        };
        await this.persistQuietly('pending 复用会话');
      }
      if (!sessionId) {
        const request = {
          workspaceId: this.resolveWorkspaceId(),
        };
        if (typeof this.config.agentPreset === 'string' && this.config.agentPreset) {
          request.agentPreset = this.config.agentPreset;
        }
        sessionId = await this.host.createSession(request);
        this.trackSession(sessionId, todo.id, promptStartedAt, trackSlot, requestId);
        this.state.pending[todo.id] = {
          sessionId,
          createdAt: promptStartedAt,
          automatic: trackSlot,
          followUp,
          routed: false,
          requestId,
          round,
          firstAcceptedAt,
          history,
          openMrs: [...ownMrs],
          item: todo,
        };
        await this.persistQuietly('pending Session');
        await this.host.renameSession(sessionId, sessionTitle);
      }
      if (reserved) {
        this.releaseReservation();
        reserved = false;
      }
      if (!route && !reuse) {
        // 新开会话固定用会话模型；路由到已有会话与复用回合不改其模型。
        const modelSelection = this.state.settings.sessionModel;
        if (modelSelection) {
          await this.host.selectModel({
            sessionId,
            ...modelSelection,
          });
        }
      }
      const settings = this.state.settings;
      const followUpsAllowed = settings.followUpEnabled !== false ? settings.maxFollowUps : 0;
      // 本轮若没闭环，插件还会不会自动续办：以“补救轮数”预算估算（纯等待轮不消耗预算），
      // 提示词里的表述是预算性质的，实际以插件结算核对为准。
      const prevWaitRounds = Number.isSafeInteger(previous?.waitRounds) ? previous.waitRounds : 0;
      const actionRoundsUsed = Math.max(0, (continuing ? (previous.round ?? 1) : 0) - prevWaitRounds);
      // 本轮先按“会消耗一个补救名额”保守估算（若本轮实为纯等待，结算时不消耗）。
      const autoFollowUp = trackSlot && actionRoundsUsed + 1 <= followUpsAllowed;
      const relatedOpen = this.relatedOpenTodos(todo);
      const carriedMrs = normalizeMrUrls([...ownMrs, ...relatedOpen.flatMap((entry) => entry.openMrs)], todo.url);
      // 预检折叠进本条目的重复提及：带进提示词，要求会话覆盖处理并在回复中说明合并。
      const mergedDuplicates = Object.values(this.state.handled)
        .filter((entry) => entry?.mergedInto === todo.id && entry.outcome === 'precheck-skipped')
        .slice(0, 5)
        .map((entry) => ({
          todoId: entry.id,
          author: entry.author ?? '',
          excerpt: entry.excerpt ?? '',
        }));
      await this.host.prompt({
        requestId,
        sessionId,
        mode: route?.mode ?? 'queue',
        content: [{
          type: 'text',
          text: (isIssueItem(todo) ? buildIssuePrompt : buildTodoPrompt)(todo, {
            me: { username: this.gitlabUsername, id: this.gitlabUserId },
            sessionTitle: effectiveTitle,
            now: Date.now(),
            round,
            maxRounds: trackSlot ? Math.max(round, 1 + followUpsAllowed + prevWaitRounds) : round,
            autoFollowUp,
            followUpDelayMinutes: settings.followUpDelayMinutes,
            customRules: settings.customRules,
            signature: settings.replySignature
              ? (settings.signatureText || DEFAULT_SIGNATURE_TEXT)
              : '',
            waitBudgetMinutes: WAIT_BUDGET_MINUTES,
            history,
            carriedMrs,
            relatedOpen,
            mergedDuplicates,
            route: route ? { mode: route.mode } : null,
            sameSession: reused,
            mayReuse: settings.followUpReuseSession !== false,
            missingReply: continuing && previous.replied === false,
          }),
        }],
      });
      const record = {
        id: todo.id,
        sessionId,
        outcome: 'session-accepted',
        executionStatus: 'running',
        automatic: trackSlot,
        routed: route !== null,
        routeMode: route?.mode ?? '',
        requestId,
        sessionTitle: effectiveTitle,
        archived: false,
        archiveError: '',
        acceptedAt: Date.now(),
        title: todo.title,
        url: todo.url,
        project: todo.project,
        round,
        firstAcceptedAt,
        history,
        waitRounds: continuing ? prevWaitRounds : 0,
        waitProbes: 0,
        reused,
        reuseCount,
        dispatchFailures: 0,
        // 链路上累计的未合并 MR：没有新结案报告时沿用上一轮的记录。
        openMrs: [...ownMrs],
        // 续办时 Todo 可能已不在待办列表，随记录保存一份（正文不保存，提示词用不到）。
        item: { ...todo, body: '' },
        closure: '',
        closureNote: '',
        nextAttemptAt: null,
        replied: null,
        reportStatus: '',
        reportSummary: '',
        resumeAfterMinutes: null,
      };
      this.state.handled[todo.id] = record;
      delete this.state.pending[todo.id];
      this.state.recent = [record, ...this.state.recent.filter((item) => item.id !== todo.id)].slice(0, 50);
      this.state.lastDispatchError = null;
      await this.persistQuietly('已接受 Todo');
      return { ok: true, sessionId, duplicate: false, routed: route !== null, routeMode: route?.mode ?? '' };
    } catch (error) {
      if (reserved) {
        this.releaseReservation();
        reserved = false;
      }
      if (sessionId && !(!pending?.requestId && pending?.sessionId === sessionId)) this.untrackTodo(sessionId, todo.id);
      // 续办会话没开起来：按失败次数指数退避重试；连续失败达到上限或链路超时则升级需人工（进收件箱），
      // 不再无限每 5 分钟重试。
      if (followUp && previous?.closure === 'follow-up') {
        previous.dispatchFailures = (Number.isSafeInteger(previous.dispatchFailures) ? previous.dispatchFailures : 0) + 1;
        const agedOut = Date.now() - (previous.firstAcceptedAt ?? previous.acceptedAt ?? Date.now()) > FOLLOW_UP_MAX_AGE_MS;
        if (previous.dispatchFailures >= FOLLOW_UP_MAX_DISPATCH_FAILURES || agedOut) {
          previous.closure = 'needs-human';
          previous.closureNote = `续办会话连续 ${previous.dispatchFailures} 次派发失败：${errorMessage(error)}`.slice(0, 500);
          previous.nextAttemptAt = null;
          previous.watch = null;
        } else {
          const retryMs = Math.min(FOLLOW_UP_RETRY_MS * 2 ** (previous.dispatchFailures - 1), 60 * 60 * 1000);
          previous.nextAttemptAt = Date.now() + retryMs;
        }
      }
      this.state.lastDispatchError = `Todo ${todo.id} 创建或驱动 Session 失败：${errorMessage(error)}`;
      await this.persistQuietly('派发错误');
      this.ctx.logger?.warn?.(`[gitlab-todo-agent] ${this.state.lastDispatchError}`);
      return { ok: false, error: this.state.lastDispatchError, sessionId };
    }
  },
};
