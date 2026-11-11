import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DshHostClient } from './dsh-host.js';
import {
  assessClosure,
  buildJudgePrompt,
  buildSessionTitle,
  buildTodoPrompt,
  buildWorkspaceOverview,
  classifyTodo,
  discussionsApiPath,
  initialState,
  normalizeMrUrls,
  normalizeState,
  normalizeTodos,
  normalizeWorkspacePath,
  parseJudgeReply,
  publicState,
  selectPendingTodos,
  sessionPage,
  STATE_VERSION,
  targetKey,
  validateSettings,
} from './core.js';

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STORAGE_DIRECTORY = join(homedir(), '.dsh-plugins', 'gitlabtodo');
const LEGACY_STATE_FILE = join(PACKAGE_DIR, '.runtime', 'state.json');
const TODO_PAGE_SIZE = 100;
const MAX_TODO_PAGES = 20;
const MAX_RULE_SKIPS_PER_POLL = 20;
const PRECHECK_CONCURRENCY = 3;
/** 规则即可判定无需处理的类别 → 标记理由（零模型调用）。 */
const RULE_SKIP_REASONS = {
  'pipeline-notify': '流水线通知，规则判定无需处理',
  'self-mention': '自己 @ 自己，规则判定无需处理',
  'description-mention': '正文 @ 提及（非评论），规则判定无需处理',
  'assignment-notify': '指派通知（Issue/MR 被指派给我），规则判定无需处理',
};
/** 核对“讨论串里有没有我方回复”时最多翻的 discussions 页数（每页 100）。 */
const MAX_DISCUSSION_PAGES = 10;
/** 自首轮派发起超过这个时长的链路不再自动续办，避免升级或长期遗留记录触发续办风暴。 */
const FOLLOW_UP_MAX_AGE_MS = 72 * 60 * 60 * 1000;
/** 续办会话创建失败后的重试间隔。 */
const FOLLOW_UP_RETRY_MS = 5 * 60 * 1000;
/** 会话空闲且没有回合结束记录，连续这么多次核对后按“被中断”结算（默认约 2 分钟）。 */
const IDLE_SETTLE_POLLS = 40;
/** 提示词里告诉会话的 CI 等待预算。 */
const WAIT_BUDGET_MINUTES = 20;
const BRIDGE_PATH = '/api/gitlab-todo-agent';
const MAX_REQUEST_BYTES = 128 * 1024;

/** 有界并发顺序保持的 map：用于轮询阶段并行跑 LLM 预检。 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    () => (async () => {
      while (index < items.length) {
        const current = index;
        index += 1;
        results[current] = await worker(items[current], current);
      }
    })(),
  );
  await Promise.all(runners);
  return results;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export class GitlabTodoRuntime {
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.config = config;
    this.state = null;
    this.timer = null;
    this.initialTimer = null;
    this.pollPromise = null;
    this.dispatches = new Map();
    this.activeChild = null;
    this.writeChain = Promise.resolve();
    this.stopping = false;
    this.unregisterRoute = null;
    this.gitlabUserId = null;
    this.gitlabUsername = null;
    this.host = new DshHostClient(ctx);
    this.trackedSessions = new Map();
    this.slotReservations = 0;
    this.statusWaiters = new Set();
    this.sessionRosterKnown = false;
    this.reconcilePromise = null;
    this.sessionTimer = null;
    this.dispatchQueue = [];
    this.pumpPromise = null;
  }

  storageDirectory() {
    return this.config.storageDirectory ?? DEFAULT_STORAGE_DIRECTORY;
  }

  stateFile() {
    return join(this.storageDirectory(), 'state.json');
  }

  legacyStateFiles() {
    return this.config.legacyStateFile ? [this.config.legacyStateFile] : [LEGACY_STATE_FILE];
  }

  async ensureStorage() {
    await mkdir(this.storageDirectory(), { recursive: true });
  }

  async start() {
    await this.ensureStorage();
    let migrated = false;
    try {
      const stored = JSON.parse(await readFile(this.stateFile(), 'utf8'));
      migrated = typeof stored?.version === 'number' && stored.version !== STATE_VERSION;
      this.state = normalizeState(stored);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`读取插件状态失败：${errorMessage(error)}`);
      for (const legacyFile of this.legacyStateFiles()) {
        try {
          const legacy = JSON.parse(await readFile(legacyFile, 'utf8'));
          this.state = normalizeState(legacy);
          migrated = true;
          break;
        } catch (legacyError) {
          if (legacyError?.code !== 'ENOENT') throw new Error(`迁移插件状态失败：${errorMessage(legacyError)}`);
        }
      }
      this.state ??= initialState();
    }
    if (migrated) await this.persistQuietly('迁移');
    this.unregisterRoute = this.ctx.connection.fetch.register({
      path: BRIDGE_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: (request) => this.handleFetch(request),
    });
    await this.reconcileSessions();
    this.resetTimer();
  }

  async stop() {
    this.stopping = true;
    this.dispatchQueue = [];
    this.wakeWaiters();
    clearInterval(this.timer);
    clearInterval(this.sessionTimer);
    clearTimeout(this.initialTimer);
    if (this.unregisterRoute) await this.unregisterRoute();
    this.unregisterRoute = null;
    this.activeChild?.kill();
    await Promise.allSettled([
      this.reconcilePromise?.catch(() => {}),
      this.pumpPromise?.catch(() => {}),
      this.writeChain.catch(() => {}),
    ]);
    await this.host.dispose();
  }

  snapshot() {
    return {
      ...publicState(this.state, Boolean(this.pollPromise), this.gitlabUserId),
      activeSessions: [...this.trackedSessions.values()].filter((record) => record.countsSlot).length,
      queuedSessions: this.dispatchQueue.length,
      storage: {
        directory: this.storageDirectory(),
      },
    };
  }

  async persist() {
    const snapshot = JSON.stringify(this.state, null, 2);
    const operation = this.writeChain.catch(() => {}).then(async () => {
      await mkdir(this.storageDirectory(), { recursive: true });
      const temporary = join(this.storageDirectory(), `state-${process.pid}-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, this.stateFile());
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
    });
    this.writeChain = operation;
    return operation;
  }

  async persistQuietly(area) {
    try {
      await this.persist();
    } catch (error) {
      const message = `保存${area}状态失败：${errorMessage(error)}`;
      this.state.lastDispatchError = message;
      this.ctx.logger?.warn?.(`[gitlab-todo-agent] ${message}`);
    }
  }

  resetTimer() {
    clearInterval(this.timer);
    clearTimeout(this.initialTimer);
    this.timer = null;
    this.initialTimer = null;
    if (this.stopping || !this.state?.settings.enabled) return;
    this.timer = setInterval(() => {
      void this.poll('timer');
    }, this.state.settings.intervalSeconds * 1000);
    this.timer.unref?.();
    this.initialTimer = setTimeout(() => {
      void this.poll('startup');
    }, 500);
    this.initialTimer.unref?.();
  }

  async updateSettings(patch) {
    const next = validateSettings(patch, this.state.settings);
    this.state.settings = next;
    await this.persistQuietly('设置');
    this.resetTimer();
    this.wakeWaiters();
    return this.snapshot();
  }

  llmRuntime() {
    let llm = null;
    if (typeof this.ctx.get === 'function') {
      try {
        llm = this.ctx.get('llm') ?? null;
      } catch {
        llm = null;
      }
    }
    if (!llm) {
      try {
        llm = this.ctx.llm ?? null;
      } catch {
        llm = null;
      }
    }
    return llm && typeof llm.stream === 'function' ? llm : null;
  }

  async judgeModel() {
    // 预检可用更快的专用小模型；未配置时退回会话模型，再退回 Host 默认模型。
    if (this.state.settings.judgeModel) return this.state.settings.judgeModel;
    if (this.state.settings.sessionModel) return this.state.settings.sessionModel;
    if (!this.catalogCache) {
      try {
        this.catalogCache = await this.host.modelCatalog();
      } catch {
        this.catalogCache = null;
      }
    }
    const fallback = this.catalogCache?.default;
    return fallback?.provider && fallback?.model ? { provider: fallback.provider, model: fallback.model } : null;
  }

  /**
   * 开会话前的轻量预判：不需要处理的提及直接标记 Todo 完成。
   * 任何失败（无 llm 服务、路由不可用、超时、解析失败）一律保守判定为需要处理。
   */
  async judgeNeedsProcessing(todo) {
    const llm = this.llmRuntime();
    if (!llm) return { needsProcessing: true, reason: '' };
    const route = await this.judgeModel();
    if (!route) return { needsProcessing: true, reason: '' };
    const timeoutMs = Number.isFinite(this.config.judgeTimeoutMs) ? Math.max(1000, this.config.judgeTimeoutMs) : 30000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const messages = [{ role: 'user', content: buildJudgePrompt(todo) }];
      let stream;
      if (typeof llm.prepareCall === 'function') {
        const prepared = await llm.prepareCall(route, controller.signal);
        stream = prepared.stream({ ...prepared.config, messages, signal: controller.signal });
      } else {
        stream = llm.stream({ ...route, messages, signal: controller.signal });
      }
      let text = '';
      for await (const chunk of stream) {
        const piece = chunk?.text ?? chunk?.delta?.text ?? chunk?.content ?? '';
        if (typeof piece === 'string') text += piece;
        if (text.length > 20000) break;
      }
      const verdict = parseJudgeReply(text);
      return verdict ?? { needsProcessing: true, reason: '' };
    } catch {
      return { needsProcessing: true, reason: '' };
    } finally {
      clearTimeout(timer);
    }
  }

  concurrencyLimit() {
    const value = Number(this.state?.settings?.maxConcurrentSessions);
    return Number.isSafeInteger(value) && value >= 1 ? Math.min(value, 10) : 2;
  }

  occupiedSlots() {
    const tracked = [...this.trackedSessions.values()].filter((record) => record.countsSlot).length;
    return tracked + this.slotReservations;
  }

  hasFreeSlot() {
    return this.sessionRosterKnown && this.occupiedSlots() < this.concurrencyLimit();
  }

  sessionPollMs() {
    return Number.isFinite(this.config.sessionPollMs) ? Math.max(20, this.config.sessionPollMs) : 3000;
  }

  ensureSessionTimer() {
    const needed = !this.stopping && (this.trackedSessions.size > 0 || this.dispatchQueue.length > 0);
    if (needed && !this.sessionTimer) {
      this.sessionTimer = setInterval(() => void this.reconcileSessions(), this.sessionPollMs());
      this.sessionTimer.unref?.();
    } else if (!needed && this.sessionTimer) {
      clearInterval(this.sessionTimer);
      this.sessionTimer = null;
    }
  }

  wakeWaiters() {
    const waiters = [...this.statusWaiters];
    this.statusWaiters.clear();
    for (const wake of waiters) wake();
  }

  slotWaitMs() {
    return Number.isFinite(this.config.slotWaitMs) ? Math.max(10, this.config.slotWaitMs) : 3000;
  }

  waitForSlotSignal() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.statusWaiters.delete(wake);
        resolve();
      }, this.slotWaitMs());
      timer.unref?.();
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      this.statusWaiters.add(wake);
    });
  }

  reserveSlot() {
    this.slotReservations += 1;
  }

  releaseReservation() {
    this.slotReservations = Math.max(0, this.slotReservations - 1);
    this.wakeWaiters();
  }

  trackSession(sessionId, todoId, startedAt = Date.now(), countsSlot = true) {
    if (!sessionId || this.trackedSessions.has(sessionId)) return;
    this.trackedSessions.set(sessionId, { todoId, startedAt, countsSlot, unreadablePolls: 0, idlePolls: 0 });
    this.ensureSessionTimer();
  }

  untrackSession(sessionId) {
    if (this.trackedSessions.delete(sessionId)) this.wakeWaiters();
    this.ensureSessionTimer();
  }

  reconcileSessions() {
    if (this.reconcilePromise) return this.reconcilePromise;
    const operation = this.executeReconcile().finally(() => {
      if (this.reconcilePromise === operation) this.reconcilePromise = null;
    });
    this.reconcilePromise = operation;
    return operation;
  }

  async executeReconcile() {
    if (this.stopping) return;
    try {
      const value = await this.host.listSessions();
      if (!Array.isArray(value?.items)) throw new Error('session/list 响应缺少 items 数组。');
      this.sessionRosterKnown = true;
      const byId = new Map(value.items.map((item) => [String(item.sessionId), item]));
      const owned = new Map();
      for (const record of Object.values(this.state.handled)) {
        if (record?.sessionId && record.automatic !== false) {
          owned.set(record.sessionId, {
            todoId: record.id,
            startedAt: record.acceptedAt,
            // 状态里仍是 running 却没人跟踪：上次运行被重启打断的遗留记录，需要接管结算。
            orphaned: record.executionStatus === 'running',
          });
        }
      }
      for (const record of Object.values(this.state.pending)) {
        if (record?.sessionId && record.item?.id && record.automatic !== false) {
          owned.set(record.sessionId, { todoId: record.item.id, startedAt: record.createdAt, orphaned: false });
        }
      }
      // 重启恢复：接管名册明确报告 running 的插件会话（占并发槽），
      // 以及状态停在 running 的遗留会话（不占槽，只为把它结算掉，避免永远悬空）。
      for (const [sessionId, record] of owned) {
        if (this.trackedSessions.has(sessionId)) continue;
        const running = byId.get(sessionId)?.running === true;
        if (running) this.trackSession(sessionId, record.todoId, record.startedAt);
        else if (record.orphaned && !this.dispatches.has(record.todoId)) {
          this.trackSession(sessionId, record.todoId, record.startedAt, false);
        }
      }

      let changed = false;
      let settled = false;
      for (const [sessionId, tracked] of [...this.trackedSessions]) {
        const summary = byId.get(sessionId);
        const handled = this.state.handled[tracked.todoId];
        const originUrl = handled?.sessionId === sessionId ? handled.url : this.state.pending[tracked.todoId]?.item?.url;
        const inspection = await this.host.inspectSession(sessionId, tracked.startedAt, summary, { originUrl });
        if (inspection.outcome === 'pending') {
          tracked.unreadablePolls = inspection.unreadable ? tracked.unreadablePolls + 1 : 0;
          // 派发仍在进行（提示词尚未送达）时的空闲不计入“被中断”。
          tracked.idlePolls = inspection.idle && !this.dispatches.has(tracked.todoId) ? tracked.idlePolls + 1 : 0;
          if (tracked.unreadablePolls >= 24) {
            inspection.outcome = 'failed';
            inspection.error = `会话空闲但执行历史持续不可读：${inspection.reason ?? '未知原因'}`;
          } else if (tracked.idlePolls >= IDLE_SETTLE_POLLS) {
            inspection.outcome = 'failed';
            inspection.error = '会话空闲但没有回合结束记录（回合未启动或被重启中断）';
          } else {
            continue;
          }
        }
        if (handled?.sessionId === sessionId) {
          handled.executionStatus = inspection.outcome === 'succeeded' ? 'completed' : 'failed';
          handled.completedAt = Date.now();
          handled.executionError = inspection.error ?? '';
          // 回合结束只说明“会话停了”，是否闭环要再核对 GitLab 事实（见 verifySettled）。
          handled.closure = 'verifying';
          handled.closureNote = '';
          handled.nextAttemptAt = null;
          const report = inspection.report ?? null;
          handled.reportStatus = report?.status ?? '';
          handled.reportSummary = report?.summary ?? '';
          handled.resumeAfterMinutes = report?.resumeAfterMinutes ?? null;
          handled.reportNoAction = report?.noAction === true;
          if (report) handled.openMrs = normalizeMrUrls(report.openMrs, handled.url);
          changed = true;
          settled = true;
        }
        this.untrackSession(sessionId);
      }
      if (changed) await this.persistQuietly('执行结算');
      this.wakeWaiters();
      if (settled) await this.verifySettled();
    } catch (error) {
      this.ctx.logger?.warn?.(`[gitlab-todo-agent] 会话状态核对失败：${errorMessage(error)}`);
    } finally {
      this.ensureSessionTimer();
    }
  }

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
  }

  /**
   * 闭环裁决。todos 必须是 fetchStartedAt 时刻之后取得的待办列表：
   * - verifying：回合在取数之前就已结束的记录才裁决（取数早于回合结束的列表可能还带着已标记的 Todo）。
   * - follow-up / needs-human：Todo 已从待办列表消失（被续办会话、关联会话或人标记完成）→ 闭环。
   */
  async assessClosures(todos, fetchStartedAt) {
    const pendingIds = new Set(todos.map((todo) => todo.id));
    let changed = false;
    for (const record of Object.values(this.state.handled)) {
      if (!record?.sessionId || !record.closure || record.closure === 'closed') continue;
      if (this.trackedSessions.has(record.sessionId) || this.dispatches.has(record.id)) continue;
      const todoPending = pendingIds.has(record.id);
      if (record.closure === 'verifying') {
        if ((record.completedAt ?? 0) > fetchStartedAt) continue;
        await this.concludeRecord(record, todoPending);
        changed = true;
      } else if (!todoPending && record.replied !== false) {
        record.closure = 'closed';
        record.closureNote = 'Todo 已不在待办列表（已被标记完成）';
        record.nextAttemptAt = null;
        await this.archiveRecord(record);
        changed = true;
      }
    }
    return changed;
  }

  /** 对一条刚结算的记录下闭环结论，并按结论归档。 */
  async concludeRecord(record, todoPending) {
    const settings = this.state.settings;
    const item = record.item ?? this.state.todos.find((todo) => todo.id === record.id) ?? null;
    // 会话判定为“仅被提及”且 Todo 已标记完成：本就不该回复，不核对讨论串。
    const mentionOnly = record.reportNoAction === true && !todoPending;
    const replied = item?.noteId && !mentionOnly ? await this.checkReplied(item) : null;
    const round = record.round ?? 1;
    let followUpBlocked = '';
    if (record.automatic === false) followUpBlocked = '手动派发的会话不自动续办';
    else if (settings.followUpEnabled === false) followUpBlocked = '自动续办未开启';
    else if (round > settings.maxFollowUps) followUpBlocked = `已达自动处理上限（共 ${round} 轮）`;
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
    });
    record.replied = replied;
    if (mentionOnly && verdict.closure === 'closed') verdict.note = `仅被提及，无需处理：${record.reportSummary || '会话判定无行动要求'}`.slice(0, 500);
    record.closure = verdict.closure;
    record.closureNote = verdict.note;
    record.nextAttemptAt = verdict.closure === 'follow-up' ? Date.now() + verdict.delayMinutes * 60000 : null;
    // 需人工接手的会话保留不归档，方便人直接打开接着做；闭环或已排续办的才归档。
    if (verdict.closure !== 'needs-human') await this.archiveRecord(record);
  }

  /** 归档一条记录的会话：仅限回合成功结束的（失败会话保留供排查），且受自动归档开关控制。 */
  async archiveRecord(record) {
    if (!record?.sessionId || record.archived) return;
    if (record.executionStatus !== 'completed' || this.state.settings.autoArchive === false) return;
    try {
      await this.host.archiveSession(record.sessionId);
      record.archived = true;
      record.archiveError = '';
    } catch (archiveError) {
      // 归档失败不影响闭环结论；仍有工作在跑等拒绝只记录原因，不强行停止任何工作。
      record.archiveError = errorMessage(archiveError);
      this.ctx.logger?.warn?.(`[gitlab-todo-agent] 归档会话 ${record.sessionId} 失败：${record.archiveError}`);
    }
  }

  /**
   * 核对原 note 所在讨论串里、原 note 之后是否有我方账号的回复。
   * true/false 为确定结论；null 为无法判断（目标类型不支持、接口失败、没找到讨论串），按未知处理。
   */
  async checkReplied(item) {
    const api = discussionsApiPath(item?.url);
    if (!api || !item?.noteId || !this.gitlabUserId) return null;
    try {
      for (let page = 1; page <= MAX_DISCUSSION_PAGES; page += 1) {
        const stdout = await this.runGlab(['api', '-X', 'GET', api, '-F', 'per_page=100', '-F', `page=${page}`]);
        const discussions = JSON.parse(stdout);
        if (!Array.isArray(discussions)) return null;
        for (const discussion of discussions) {
          const notes = Array.isArray(discussion?.notes) ? discussion.notes : [];
          const index = notes.findIndex((note) => String(note?.id) === item.noteId);
          if (index < 0) continue;
          return notes.slice(index + 1).some((note) => note
            && note.system !== true
            && String(note.author?.id ?? '') === this.gitlabUserId);
        }
        if (discussions.length < 100) break;
      }
    } catch {
      return null;
    }
    return null;
  }

  /** 是否有别的插件会话正在同一个 Issue/MR 上执行。 */
  targetBusy(todo) {
    const key = targetKey(todo?.url);
    if (!key) return false;
    for (const tracked of this.trackedSessions.values()) {
      if (tracked.todoId === todo.id) continue;
      const url = this.state.handled[tracked.todoId]?.url ?? this.state.pending[tracked.todoId]?.item?.url;
      if (targetKey(url) === key) return true;
    }
    return false;
  }

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
  }

  /** 把到期的续办排进派发队列；同一对象上有别的会话在跑时顺延到下一轮。 */
  enqueueFollowUps() {
    const now = Date.now();
    const queued = new Set(this.dispatchQueue.map((entry) => entry.todo.id));
    for (const record of Object.values(this.state.handled)) {
      if (record?.closure !== 'follow-up' || !record.sessionId) continue;
      if (!Number.isFinite(record.nextAttemptAt) || record.nextAttemptAt > now) continue;
      if (queued.has(record.id) || this.dispatches.has(record.id) || this.trackedSessions.has(record.sessionId)) continue;
      const item = record.item ?? this.state.todos.find((todo) => todo.id === record.id) ?? null;
      if (!item) {
        record.closure = 'needs-human';
        record.closureNote = `${record.closureNote}；缺少 Todo 数据，无法续办`.replace(/^；/, '');
        record.nextAttemptAt = null;
        continue;
      }
      if (this.targetBusy(item)) continue;
      this.dispatchQueue.push({ todo: item, followUp: true });
      queued.add(record.id);
    }
    this.ensureSessionTimer();
  }

  enqueueDispatch(todos) {
    if (!Array.isArray(todos) || todos.length === 0) return;
    const queued = new Set(this.dispatchQueue.map((entry) => entry.todo.id));
    for (const todo of todos) {
      if (queued.has(todo.id) || this.dispatches.has(todo.id) || this.state.handled[todo.id]) continue;
      this.dispatchQueue.push({ todo, followUp: false });
    }
    this.ensureSessionTimer();
  }

  pump() {
    if (this.pumpPromise) return this.pumpPromise;
    const operation = this.executePump().finally(() => {
      if (this.pumpPromise === operation) this.pumpPromise = null;
    });
    this.pumpPromise = operation;
    return operation;
  }

  async executePump() {
    while (!this.stopping && this.dispatchQueue.length > 0) {
      if (!this.hasFreeSlot()) {
        void this.reconcileSessions();
        await this.waitForSlotSignal();
        continue;
      }
      const { todo, followUp } = this.dispatchQueue.shift();
      if (followUp) {
        // 排队期间可能已被别的会话或人闭环；只有仍处于待续办的才真正开续办会话。
        if (this.state.handled[todo.id]?.closure !== 'follow-up') continue;
        await this.dispatch(todo, true, { trackSlot: true, followUp: true });
        continue;
      }
      if (this.state.handled[todo.id]) continue;
      await this.dispatch(todo, false, { trackSlot: true });
    }
  }

  async poll(source = 'manual') {
    if (this.pollPromise) return this.pollPromise;
    const operation = this.executePoll(source).finally(() => {
      if (this.pollPromise === operation) this.pollPromise = null;
    });
    this.pollPromise = operation;
    return operation;
  }

  async executePoll(source) {
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
        .filter((todo) => !this.dispatches.has(todo.id));
      this.state.lastNewCount = candidates.length;
      if (this.state.settings.enabled && this.state.settings.autoProcess) {
        // 0) 到期的续办先入队：先把已经开了头的事收尾，再开新的。
        if (this.state.settings.followUpEnabled !== false) this.enqueueFollowUps();
        // 1) 规则跳过：流水线通知、自己 @ 自己——零模型调用，程序内直接标记完成。
        if (this.state.settings.ruleSkipEnabled !== false) {
          const noise = candidates
            .filter((todo) => RULE_SKIP_REASONS[classifyTodo(todo, this.gitlabUserId)])
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
                skipReason: RULE_SKIP_REASONS[classifyTodo(todo, this.gitlabUserId)],
                title: todo.title,
                url: todo.url,
                project: todo.project,
              };
            } catch (error) {
              this.ctx.logger?.warn?.(`[gitlab-todo-agent] 规则跳过 Todo ${todo.id} 标记完成失败：${errorMessage(error)}`);
            }
          }
        }
        // 2) LLM 快速预检：在轮询阶段并行完成（不占用会话并发槽，也不阻塞队列），
        //    只有判定需要处理的 Todo 才进入派发队列，槽位空闲时会话可立即创建。
        let mentions = candidates
          .filter((todo) => !this.state.handled[todo.id] && classifyTodo(todo, this.gitlabUserId) === 'direct-mention')
          .slice(0, this.state.settings.maxSessionsPerPoll);
        if (this.state.settings.precheckEnabled && mentions.length > 0) {
          const ready = [];
          await mapLimit(mentions, PRECHECK_CONCURRENCY, async (todo) => {
            const verdict = await this.judgeNeedsProcessing(todo);
            if (!verdict.needsProcessing) {
              try {
                await this.markTodoDone(todo);
                this.state.handled[todo.id] = {
                  id: todo.id,
                  sessionId: null,
                  outcome: 'precheck-skipped',
                  automatic: true,
                  acceptedAt: Date.now(),
                  skipReason: verdict.reason,
                  title: todo.title,
                  url: todo.url,
                  project: todo.project,
                };
              } catch (error) {
                this.ctx.logger?.warn?.(`[gitlab-todo-agent] 预检跳过 Todo ${todo.id} 标记完成失败：${errorMessage(error)}`);
              }
              return;
            }
            ready.push(todo);
          });
          mentions = ready;
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
  }

  async currentGitlabUserId() {
    if (this.gitlabUserId) return this.gitlabUserId;
    const stdout = await this.runGlab(['api', 'user']);
    let user;
    try {
      user = JSON.parse(stdout);
    } catch (error) {
      throw new Error(`解析 GitLab 当前用户失败：${errorMessage(error)}`);
    }
    if ((typeof user?.id !== 'number' && typeof user?.id !== 'string') || !String(user.id).trim()) {
      throw new Error('GitLab 当前用户响应缺少有效 id。');
    }
    this.gitlabUserId = String(user.id).trim();
    this.gitlabUsername = typeof user.username === 'string' && user.username.trim() ? user.username.trim() : null;
    return this.gitlabUserId;
  }

  async fetchTodos() {
    await this.currentGitlabUserId();
    const items = [];
    for (let page = 1; page <= MAX_TODO_PAGES; page += 1) {
      const stdout = await this.runGlab([
        'api', '-X', 'GET', 'todos',
        '-F', `per_page=${TODO_PAGE_SIZE}`,
        '-F', `page=${page}`,
      ]);
      let pageItems;
      try {
        pageItems = JSON.parse(stdout);
      } catch (error) {
        throw new Error(`解析 GitLab Todo 第 ${page} 页失败：${errorMessage(error)}`);
      }
      if (!Array.isArray(pageItems)) throw new Error(`GitLab Todo 第 ${page} 页响应不是数组。`);
      if (pageItems.length === 0) break;
      items.push(...pageItems);
      if (pageItems.length < TODO_PAGE_SIZE) break;
    }
    return normalizeTodos(items);
  }

  async runGlab(args) {
    const timeoutMs = Number.isFinite(this.config.requestTimeoutMs)
      ? Math.max(1000, this.config.requestTimeoutMs)
      : 90000;
    const maxOutputBytes = Number.isSafeInteger(this.config.maxOutputBytes)
      ? Math.max(1024, this.config.maxOutputBytes)
      : 2097152;
    const executable = process.platform === 'win32' ? 'glab.exe' : 'glab';
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: this.state.settings.cwd || process.cwd(),
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.activeChild = child;
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let failure = null;
      let settled = false;
      let forceTimer = null;
      const timeout = setTimeout(() => {
        failure = new Error(`GitLab 请求超过 ${timeoutMs}ms，已终止。`);
        child.kill();
        forceTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
        forceTimer.unref?.();
      }, timeoutMs);
      timeout.unref?.();

      const finish = (error, code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(forceTimer);
        if (this.activeChild === child) this.activeChild = null;
        const out = Buffer.concat(stdout).toString('utf8');
        const err = Buffer.concat(stderr).toString('utf8');
        if (error) {
          reject(error);
          return;
        }
        if (failure) {
          const detail = err.trim();
          reject(new Error(`${failure.message}${detail ? `：${detail.slice(0, 2000)}` : ''}`));
          return;
        }
        if (code !== 0) {
          const detail = err.trim() || out.trim();
          reject(new Error(`glab 退出码 ${code ?? 'null'}（${signal ?? '无信号'}）${detail ? `：${detail.slice(0, 2000)}` : ''}`));
          return;
        }
        resolve(out);
      };

      child.stdout.on('data', (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxOutputBytes) {
          failure = new Error(`GitLab 标准输出超过 ${maxOutputBytes} 字节上限。`);
          child.kill();
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes > maxOutputBytes) {
          failure = new Error(`GitLab 标准错误超过 ${maxOutputBytes} 字节上限。`);
          child.kill();
          return;
        }
        stderr.push(chunk);
      });
      child.once('error', (error) => finish(error));
      child.once('close', (code, signal) => finish(null, code, signal));
    });
  }

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
  }

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
  }

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
  }

  async dispatchById(id) {
    const todo = this.state.todos.find((item) => item.id === id);
    if (!todo) return { ok: false, error: '当前轮询结果中找不到该 Todo，请先重新检查。' };
    return this.dispatch(todo, Boolean(this.state.handled[id]));
  }

  async dispatch(todo, force = false, options = {}) {
    const existingSessionId = this.state.handled[todo.id]?.sessionId ?? this.state.pending[todo.id]?.sessionId;
    if (force && existingSessionId && this.trackedSessions.has(existingSessionId)) {
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
  }

  async markTodoDone(todo) {
    await this.runGlab(['api', '-X', 'POST', `todos/${encodeURIComponent(todo.id)}/mark_as_done`]);
  }

  /**
   * 手动切换一个插件会话的归档状态（面板“最近会话”快捷操作）。
   * 只作用于插件自己派发过的会话；归档仍在执行的会话会被 Host 拒绝，原样把错误带回去。
   */
  async setSessionArchived(sessionId, archived) {
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, error: '缺少 sessionId。' };
    if (typeof archived !== 'boolean') return { ok: false, error: 'archived 必须是布尔值。' };
    const record = Object.values(this.state.handled).find((item) => item?.sessionId === sessionId);
    if (!record) return { ok: false, error: '该会话不是插件创建的会话。' };
    if (archived && this.trackedSessions.has(sessionId)) {
      return { ok: false, error: '会话仍在执行，结算后再变更归档状态。' };
    }
    try {
      if (archived) await this.host.archiveSession(sessionId);
      else await this.host.unarchiveSession(sessionId);
      record.archived = archived;
      if (archived) record.archiveError = '';
      await this.persistQuietly('会话归档状态');
      return { ok: true };
    } catch (error) {
      if (archived) record.archiveError = errorMessage(error);
      await this.persistQuietly('会话归档状态');
      throw error;
    }
  }

  async executeDispatch(todo, force, options = {}) {
    const trackSlot = Boolean(options.trackSlot);
    const followUp = Boolean(options.followUp);
    // 续办创建会话后若提示词发送失败，下次续办复用那个 pending 会话，不再多建空会话。
    let sessionId = force && !followUp ? null : this.state.pending[todo.id]?.sessionId;
    // 同一 Todo 已有过会话再开新会话（自动续办或手动重新处理）：延续链路，轮次 +1。
    const previous = this.state.handled[todo.id];
    const continuing = Boolean(force && previous?.sessionId);
    const round = continuing ? (previous.round ?? 1) + 1 : 1;
    const firstAcceptedAt = continuing ? (previous.firstAcceptedAt ?? previous.acceptedAt) : Date.now();
    const history = continuing
      ? [...(Array.isArray(previous.history) ? previous.history : []), {
          sessionId: previous.sessionId,
          sessionTitle: previous.sessionTitle ?? '',
          round: previous.round ?? 1,
          endedAt: previous.completedAt ?? null,
          status: previous.reportStatus || previous.executionStatus || '',
          note: previous.closureNote || previous.reportSummary || previous.executionError || '',
        }].slice(-10)
      : [];
    const sessionTitle = buildSessionTitle(todo, round);
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
      if (trackSlot) {
        this.reserveSlot();
        reserved = true;
      }
      if (sessionId) {
        this.trackSession(sessionId, todo.id, Date.now(), trackSlot);
      }
      if (!sessionId) {
        const request = {
          workspaceId: this.resolveWorkspaceId(),
        };
        if (typeof this.config.agentPreset === 'string' && this.config.agentPreset) {
          request.agentPreset = this.config.agentPreset;
        }
        sessionId = await this.host.createSession(request);
        this.trackSession(sessionId, todo.id, Date.now(), trackSlot);
        this.state.pending[todo.id] = {
          sessionId,
          createdAt: Date.now(),
          automatic: trackSlot,
          item: todo,
        };
        await this.persistQuietly('pending Session');
        await this.host.renameSession(sessionId, sessionTitle);
      }
      if (reserved) {
        this.releaseReservation();
        reserved = false;
      }
      if (this.state.settings.sessionModel) {
        await this.host.selectModel({
          sessionId,
          ...this.state.settings.sessionModel,
        });
      }
      const settings = this.state.settings;
      const followUpsAllowed = settings.followUpEnabled !== false ? settings.maxFollowUps : 0;
      // 本轮若没闭环，插件还会不会自动续办：只有自动派发、开关开启且轮数未用尽时才会。
      const autoFollowUp = trackSlot && round <= followUpsAllowed;
      const relatedOpen = this.relatedOpenTodos(todo);
      const ownMrs = continuing && Array.isArray(previous.openMrs) ? previous.openMrs : [];
      const carriedMrs = normalizeMrUrls([...ownMrs, ...relatedOpen.flatMap((entry) => entry.openMrs)], todo.url);
      await this.host.prompt({
        requestId: `gitlab-todo-${randomUUID()}`,
        sessionId,
        mode: 'queue',
        content: [{
          type: 'text',
          text: buildTodoPrompt(todo, {
            me: { username: this.gitlabUsername, id: this.gitlabUserId },
            sessionTitle,
            now: Date.now(),
            round,
            maxRounds: trackSlot ? Math.max(round, 1 + followUpsAllowed) : round,
            autoFollowUp,
            followUpDelayMinutes: settings.followUpDelayMinutes,
            waitBudgetMinutes: WAIT_BUDGET_MINUTES,
            history,
            carriedMrs,
            relatedOpen,
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
        sessionTitle,
        archived: false,
        archiveError: '',
        acceptedAt: Date.now(),
        title: todo.title,
        url: todo.url,
        project: todo.project,
        round,
        firstAcceptedAt,
        history,
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
      return { ok: true, sessionId, duplicate: false };
    } catch (error) {
      if (reserved) {
        this.releaseReservation();
        reserved = false;
      }
      if (sessionId) this.untrackSession(sessionId);
      // 续办会话没开起来：记录保持待续办，隔一段时间再试，不在每轮轮询里连续重试。
      if (followUp && previous?.closure === 'follow-up') previous.nextAttemptAt = Date.now() + FOLLOW_UP_RETRY_MS;
      this.state.lastDispatchError = `Todo ${todo.id} 创建或驱动 Session 失败：${errorMessage(error)}`;
      await this.persistQuietly('派发错误');
      this.ctx.logger?.warn?.(`[gitlab-todo-agent] ${this.state.lastDispatchError}`);
      return { ok: false, error: this.state.lastDispatchError, sessionId };
    }
  }

  async handleFetch(request) {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.searchParams.get('action') === 'state') {
        return jsonResponse(200, { ok: true, state: this.snapshot() });
      }
      if (request.method === 'GET' && url.searchParams.get('action') === 'models') {
        return jsonResponse(200, { ok: true, catalog: await this.host.modelCatalog() });
      }
      if (request.method === 'GET' && url.searchParams.get('action') === 'workspaces') {
        return jsonResponse(200, { ok: true, workspaces: await this.workspaceOverview() });
      }
      if (request.method !== 'POST') {
        return jsonResponse(405, { ok: false, error: '不支持的请求方法。' });
      }
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
        return jsonResponse(415, { ok: false, error: 'POST 请求必须使用 application/json。' });
      }
      const raw = await request.text();
      if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES) {
        return jsonResponse(413, { ok: false, error: `请求体超过 ${MAX_REQUEST_BYTES} 字节上限。` });
      }
      const body = JSON.parse(raw || '{}');
      if (body.action === 'models') {
        return jsonResponse(200, { ok: true, catalog: await this.host.modelCatalog() });
      }
      if (body.action === 'workspaces') {
        return jsonResponse(200, { ok: true, workspaces: await this.workspaceOverview() });
      }
      if (body.action === 'poll') {
        const state = await this.poll('manual');
        return jsonResponse(200, { ok: true, state });
      }
      if (body.action === 'sessions') {
        // “最近会话”分页：首页默认 30 条，limit 上限 100，offset 由客户端翻页推进。
        return jsonResponse(200, { ok: true, ...sessionPage(this.state, body.offset, body.limit) });
      }
      if (body.action === 'setSessionArchived' && typeof body.sessionId === 'string') {
        const result = await this.setSessionArchived(body.sessionId, body.archived === true);
        return jsonResponse(200, { ok: true, result, state: this.snapshot() });
      }
      if (body.action === 'updateSettings') {
        const state = await this.updateSettings(body.settings);
        return jsonResponse(200, { ok: true, state });
      }
      if (body.action === 'dispatch' && (typeof body.id === 'string' || typeof body.id === 'number')) {
        const result = await this.dispatchById(String(body.id));
        return jsonResponse(200, { ok: true, result, state: this.snapshot() });
      }
      return jsonResponse(400, { ok: false, error: '未知 bridge action。' });
    } catch (error) {
      return jsonResponse(400, { ok: false, error: errorMessage(error) });
    }
  }
}

export const inject = ['connection', 'typertGateway', 'workspaceRegistry'];

export function apply(ctx, config = {}) {
  const runtime = new GitlabTodoRuntime(ctx, config);
  return ctx.effect(async () => {
    await runtime.start();
    return () => runtime.stop();
  }, 'gitlab-todo-agent: runtime');
}
