import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DshHostClient } from './dsh-host.js';
import {
  assessClosure,
  buildBatchJudgePrompt,
  buildInbox,
  buildJudgePrompt,
  buildSessionTitle,
  buildTodoPrompt,
  buildWorkspaceOverview,
  classifyTodo,
  DEFAULT_SIGNATURE_TEXT,
  discussionsApiPath,
  findRouteTargets,
  initialState,
  mrApiPath,
  mrWatchState,
  normalizeMrUrls,
  normalizeState,
  normalizeTodos,
  normalizeWorkspacePath,
  parseBatchJudgeReply,
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
/** 同一 Todo 预检连续失败这么多轮后降级为直接派发（此前每轮都会跳过）。 */
const PRECHECK_MAX_SKIPS = 2;
/** 等待探测：连续这么多次“无变化而推迟”后放行一次心跳续办会话。 */
const WAIT_PROBE_MAX_DEFERS = 4;
/** 同一会话最多被后续轮次接力复用的次数（含首轮共 1+N 个回合），避免上下文无限增长。 */
const MAX_SESSION_REUSE = 2;
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
/** 续办会话创建失败后的重试间隔（随失败次数指数退避）。 */
const FOLLOW_UP_RETRY_MS = 5 * 60 * 1000;
/** 续办派发连续失败这么多次后升级需人工，不再无限重试。 */
const FOLLOW_UP_MAX_DISPATCH_FAILURES = 5;
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

/** 兼容多种 llm 流分片形态，取出文本增量。 */
function chunkText(chunk) {
  if (typeof chunk === 'string') return chunk;
  const candidates = [
    chunk?.text, chunk?.delta?.text, chunk?.textDelta, chunk?.content,
    typeof chunk?.delta === 'string' ? chunk.delta : null,
    chunk?.choices?.[0]?.delta?.content,
  ];
  for (const piece of candidates) if (typeof piece === 'string') return piece;
  return '';
}

function judgeOutputError(text) {
  const sample = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return sample ? `预检模型输出无法解析：${sample}` : '预检模型没有返回任何文本。';
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** session/list 的人类可读标题在投影里，不在 item 顶层。 */
function sessionSummaryTitle(summary) {
  const title = summary?.projections?.values?.title;
  return typeof title === 'string' ? title.trim() : '';
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
    this.activeChildren = new Set();
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
    // 本轮批量预检的判定（todoId → verdict）：派发时消费（taskType 选模型、preferSession 决定路由）。
    this.judgeVerdicts = new Map();
    // 预检连续失败计数（todoId → 次数）：失败本轮跳过，获得判定或被处理后清零。
    this.precheckFailures = new Map();
    this.lastJudgeError = '';
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
    // 逐个终止所有在飞的 glab 子进程（poll 与核对可能并发，单槽引用会漏杀先前的进程）。
    for (const child of this.activeChildren) child.kill();
    this.activeChildren.clear();
    await Promise.allSettled([
      this.reconcilePromise?.catch(() => {}),
      this.pumpPromise?.catch(() => {}),
      this.pollPromise?.catch(() => {}),
      this.writeChain.catch(() => {}),
    ]);
    await this.host.dispose();
  }

  snapshot() {
    return {
      ...publicState(this.state, Boolean(this.pollPromise), this.gitlabUserId),
      activeSessions: [...this.trackedSessions.values()].filter(
        (record) => [...record.todos.values()].some((entry) => entry.countsSlot),
      ).length,
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
      // 持久化故障与派发错误分账：写进独立字段，不污染面板上“最近派发错误”的语义。
      const message = `保存${area}状态失败：${errorMessage(error)}`;
      this.state.lastPersistError = message;
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
      // 启用瞬间可能恰有一轮“未启用”的轮询在飞：直接 poll 会并入它（已跳过派发阶段），
      // 导致启用后要等一个完整间隔才开始处理。先等它结束，再跑一轮完整的。
      void (async () => {
        if (this.pollPromise) await this.pollPromise.catch(() => {});
        if (!this.stopping && this.state?.settings.enabled) await this.poll('startup');
      })();
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
   * 任何失败（无 llm 服务、路由不可用、超时、解析失败）返回 null：调用方让该 Todo
   * 本轮跳过（不标记、不开会话），留待下一轮重试——对代发账号，误开会话公开回复
   * 比晚一轮处理更难收回。
   */
  async judgeNeedsProcessing(todo) {
    const llm = this.llmRuntime();
    if (!llm) {
      this.lastJudgeError = '宿主未提供 llm 服务，预检不可用。';
      return null;
    }
    const route = await this.judgeModel();
    if (!route) {
      this.lastJudgeError = '没有可用的预检模型（未配置预检/Session 模型，也读不到宿主默认模型）。';
      return null;
    }
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
        text += chunkText(chunk);
        if (text.length > 20000) break;
      }
      const verdict = parseJudgeReply(text);
      if (!verdict) this.lastJudgeError = judgeOutputError(text);
      return verdict;
    } catch (error) {
      this.lastJudgeError = `预检模型调用失败：${errorMessage(error)}`.slice(0, 300);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 批量预检的同目标会话上下文：给 judge 判断 preferSession（reuse/new）用。 */
  batchSameTargetContext(todos) {
    const context = {};
    for (const todo of todos) {
      const key = targetKey(todo?.url ?? '');
      if (!key) continue;
      const candidates = Object.values(this.state.handled)
        .filter((record) => record?.sessionId && record.archived !== true && targetKey(record.url) === key)
        .sort((a, b) => (b.acceptedAt ?? 0) - (a.acceptedAt ?? 0))
        .slice(0, 2)
        .map((record) => ({
          title: record.sessionTitle || record.title,
          status: record.reportStatus || record.closure,
          note: record.closureNote || record.reportSummary,
        }));
      if (candidates.length > 0) context[todo.id] = candidates;
    }
    return context;
  }

  /**
   * 批量预检：一次判定本批全部提及（含优先级/重复/类型/路由倾向）。
   * 任何失败（无 llm、解析不出）返回 null，调用方退回逐条预检。
   */
  async judgeBatchVerdicts(todos) {
    const llm = this.llmRuntime();
    if (!llm) {
      this.lastJudgeError = '宿主未提供 llm 服务，预检不可用。';
      return null;
    }
    const route = await this.judgeModel();
    if (!route) {
      this.lastJudgeError = '没有可用的预检模型（未配置预检/Session 模型，也读不到宿主默认模型）。';
      return null;
    }
    const timeoutMs = Number.isFinite(this.config.judgeBatchTimeoutMs)
      ? Math.max(1000, this.config.judgeBatchTimeoutMs)
      : 60000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const messages = [{
        role: 'user',
        content: buildBatchJudgePrompt(todos, { sameTarget: this.batchSameTargetContext(todos) }),
      }];
      let stream;
      if (typeof llm.prepareCall === 'function') {
        const prepared = await llm.prepareCall(route, controller.signal);
        stream = prepared.stream({ ...prepared.config, messages, signal: controller.signal });
      } else {
        stream = llm.stream({ ...route, messages, signal: controller.signal });
      }
      let text = '';
      for await (const chunk of stream) {
        text += chunkText(chunk);
        if (text.length > 60000) break;
      }
      const verdicts = parseBatchJudgeReply(text);
      if (!verdicts) this.lastJudgeError = judgeOutputError(text);
      return verdicts;
    } catch (error) {
      this.lastJudgeError = `预检模型调用失败：${errorMessage(error)}`.slice(0, 300);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 预检入口：先批量，失败退回逐条；判定不需要处理或同批重复的直接标记完成。
   * 预检本身失败的 Todo 本轮跳过（不标记、不开会话），留待下一轮重试；连续失败
   * 记录在 precheckFailures 并周期性告警，可随时手动派发。
   * 返回仍需开会话的 Todo，按 judge 优先级（1 最先）稳定排序；
   * 判定存入 judgeVerdicts，派发时消费（taskType 选模型、preferSession 决定是否路由复用）。
   */
  async precheckMentions(mentions) {
    this.lastJudgeError = '';
    let verdicts = await this.judgeBatchVerdicts(mentions);
    if (!verdicts) {
      const fallback = await mapLimit(mentions, PRECHECK_CONCURRENCY,
        async (todo) => [todo.id, await this.judgeNeedsProcessing(todo)]);
      verdicts = new Map(fallback.filter(([, verdict]) => verdict !== null));
    }
    for (const todo of mentions) {
      if (verdicts.has(todo.id)) this.precheckFailures.delete(todo.id);
    }
    // 重复折叠的判定条件：duplicateOf 指向本批另一条“需要处理”的 Todo，且两者在同一个
    // 目标对象上（去掉 note 锚点后同源）——跨讨论串的重复提问不折叠，否则另一线程将无人回应。
    const foldableInto = (todo, verdict) => {
      if (!verdict) return null;
      const target = verdict.duplicateOf && verdict.duplicateOf !== todo.id
        ? mentions.find((item) => item.id === verdict.duplicateOf)
        : null;
      if (!target) return null;
      if (verdicts.get(verdict.duplicateOf)?.needsProcessing !== true) return null;
      if (targetKey(target.url) !== targetKey(todo.url) || !targetKey(todo.url)) return null;
      return target;
    };
    // 被别的重复项指向的主条目集合：主条目自身不再折叠（避免 a→b、b→a 互相指向时双双标完成）。
    const referencedPrimaries = new Set();
    for (const todo of mentions) {
      const target = foldableInto(todo, verdicts.get(todo.id));
      if (target) referencedPrimaries.add(target.id);
    }
    const ready = [];
    let degraded = 0;
    const missing = mentions.filter((todo) => !verdicts.has(todo.id)).length;
    // 面板可见：预检失败的原因与影响（跳过 / 降级），成功后清除。
    this.state.lastPrecheckError = missing === 0
      ? null
      : `预检失败 ${missing}/${mentions.length} 条：${this.lastJudgeError || '原因未知'}（连续 ${PRECHECK_MAX_SKIPS} 轮失败后将降级为直接派发）`;
    for (const todo of mentions) {
      const verdict = verdicts.get(todo.id);
      if (!verdict) {
        // 预检本身失败（服务不可用/超时/输出不可解析）：本轮跳过，不标记、不开会话，
        // 下一轮重试；连续失败告警。手动“开 Session 处理”不受影响。
        const failures = (this.precheckFailures.get(todo.id) ?? 0) + 1;
        this.precheckFailures.set(todo.id, failures);
        const reason = this.lastJudgeError || '预检失败（原因未知）';
        if (failures < PRECHECK_MAX_SKIPS) {
          this.ctx.logger?.warn?.(`[gitlab-todo-agent] Todo ${todo.id} 预检第 ${failures} 轮失败，本轮跳过、下一轮重试：${reason}`);
          continue;
        }
        // 连续失败达到上限：预检不可用不应让自动处理永久停摆——降级为直接派发（会话自身的
        // “仅被提及”判定与危险操作护栏仍然生效），并把原因留在面板上。
        this.ctx.logger?.warn?.(`[gitlab-todo-agent] Todo ${todo.id} 预检连续 ${failures} 轮失败，降级为直接派发：${reason}`);
        degraded += 1;
        ready.push(todo);
        continue;
      }
      const target = foldableInto(todo, verdict);
      const duplicate = Boolean(target) && !referencedPrimaries.has(todo.id);
      if (!verdict.needsProcessing || duplicate) {
        const reason = duplicate
          ? `与 Todo ${verdict.duplicateOf} 是同一请求，随主条目合并处理`
          : verdict.reason;
        try {
          await this.markTodoDone(todo);
          this.state.handled[todo.id] = {
            id: todo.id,
            sessionId: null,
            outcome: 'precheck-skipped',
            automatic: true,
            acceptedAt: Date.now(),
            skipReason: reason,
            title: todo.title,
            url: todo.url,
            project: todo.project,
            // 折叠进主条目的提及：保留作者与正文摘录，主条目会话提示词会带出并要求覆盖处理。
            ...(duplicate ? {
              mergedInto: target.id,
              author: todo.author,
              excerpt: String(todo.body ?? '').slice(0, 300),
            } : {}),
          };
        } catch (error) {
          this.ctx.logger?.warn?.(`[gitlab-todo-agent] 预检跳过 Todo ${todo.id} 标记完成失败：${errorMessage(error)}`);
          // 标记失败时不丢判定：下一轮该 Todo 仍在待办列表，避免周期性重复调用预检模型。
          continue;
        }
        this.judgeVerdicts.delete(todo.id);
        continue;
      }
      this.judgeVerdicts.set(todo.id, verdict);
      ready.push(todo);
    }
    return ready
      .map((todo) => ({ todo, priority: Number(verdicts.get(todo.id)?.priority) || 3 }))
      .sort((a, b) => a.priority - b.priority)
      .map((entry) => entry.todo);
  }

  concurrencyLimit() {
    const value = Number(this.state?.settings?.maxConcurrentSessions);
    return Number.isSafeInteger(value) && value >= 1 ? Math.min(value, 10) : 2;
  }

  occupiedSlots() {
    // 并发按“有自动任务的会话”计数：同会话多条自动 Todo 不重复占槽，
    // 首条结算后，只要还有自动路由任务未结算，该会话仍持有一个槽。
    const tracked = [...this.trackedSessions.values()]
      .filter((record) => [...record.todos.values()].some((entry) => entry.countsSlot)).length;
    return tracked + this.slotReservations;
  }

  hasFreeSlot() {
    return this.sessionRosterKnown && this.occupiedSlots() < this.concurrencyLimit();
  }

  sessionPollMs() {
    return Number.isFinite(this.config.sessionPollMs) ? Math.max(20, this.config.sessionPollMs) : 3000;
  }

  ensureSessionTimer() {
    let trackedTodos = 0;
    for (const record of this.trackedSessions.values()) trackedTodos += record.todos.size;
    const needed = !this.stopping && (trackedTodos > 0 || this.dispatchQueue.length > 0);
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

  /**
   * 跟踪表结构：Map<sessionId, { todos: Map<todoId, {startedAt, requestId, countsSlot}>, unreadablePolls, idlePolls }>。
   * 一个会话可同时挂多条路由消息（排队/引导），各自按 requestId 独立结算；
   * unreadable/idle 计数是会话级的：会话空闲且仍有消息未落档时统一兜底。
   */
  trackSession(sessionId, todoId, startedAt = Date.now(), countsSlot = true, requestId = '') {
    if (!sessionId || !todoId) return;
    let record = this.trackedSessions.get(sessionId);
    if (!record) {
      record = { todos: new Map(), unreadablePolls: 0, idlePolls: 0 };
      this.trackedSessions.set(sessionId, record);
    }
    if (!record.todos.has(todoId)) {
      record.todos.set(todoId, { startedAt, requestId, countsSlot });
      this.ensureSessionTimer();
    }
  }

  /** 只解除一个 Todo 在该会话上的跟踪；会话上没有其他待结算消息时一并停表。 */
  untrackTodo(sessionId, todoId) {
    const record = this.trackedSessions.get(sessionId);
    if (!record) return;
    if (record.todos.delete(todoId)) this.wakeWaiters();
    if (record.todos.size === 0) this.untrackSession(sessionId);
    else this.ensureSessionTimer();
  }

  untrackSession(sessionId) {
    if (this.trackedSessions.delete(sessionId)) this.wakeWaiters();
    this.ensureSessionTimer();
  }

  /** 一个会话当前挂载的未结算消息数（跟踪表 + 状态里仍在 running 的记录），路由防堆积用。 */
  countSessionLoad(sessionId, excludeTodoId = '') {
    const todoIds = new Set(this.trackedSessions.get(sessionId)?.todos.keys() ?? []);
    for (const record of Object.values(this.state?.handled ?? {})) {
      if (record?.sessionId === sessionId && record.executionStatus === 'running') todoIds.add(record.id);
    }
    for (const record of Object.values(this.state?.pending ?? {})) {
      if (record?.sessionId === sessionId && record.item?.id) todoIds.add(record.item.id);
    }
    if (excludeTodoId) todoIds.delete(excludeTodoId);
    return todoIds.size;
  }

  isTodoTracked(sessionId, todoId) {
    return this.trackedSessions.get(sessionId)?.todos.has(todoId) === true;
  }

  reconcileSessions() {
    if (this.reconcilePromise) return this.reconcilePromise;
    const operation = this.executeReconcile().finally(() => {
      if (this.reconcilePromise === operation) this.reconcilePromise = null;
    });
    this.reconcilePromise = operation;
    return operation;
  }

  /** pending 的消息已在日志中证实被接受：补建 handled，再走统一结算，不再丢弃结果。 */
  materializePendingRecord(todoId, pending) {
    const item = pending.item;
    const previous = this.state.handled[todoId];
    const continuing = Boolean(previous?.sessionId);
    const round = continuing
      ? Math.max(Number.isSafeInteger(pending.round) ? pending.round : 1, (previous.round ?? 1) + 1)
      : (Number.isSafeInteger(pending.round) ? pending.round : 1);
    const history = Array.isArray(pending.history) && pending.history.length > 0
      ? pending.history
      : continuing
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
    const record = {
      id: todoId,
      sessionId: pending.sessionId,
      outcome: 'session-accepted',
      executionStatus: 'running',
      automatic: pending.automatic !== false,
      routed: pending.routed === true,
      routeMode: pending.routeMode ?? '',
      taskType: pending.taskType || previous?.taskType || '',
      requestId: pending.requestId ?? '',
      sessionTitle: pending.sessionTitle || buildSessionTitle(item, round),
      archived: false,
      archiveError: '',
      acceptedAt: pending.createdAt,
      title: item.title,
      url: item.url,
      project: item.project,
      round,
      firstAcceptedAt: continuing
        ? (previous.firstAcceptedAt ?? previous.acceptedAt)
        : (pending.firstAcceptedAt ?? pending.createdAt),
      history,
      // 跨 pending 恢复也要保留纯等待轮计数，否则轮数预算会在续办后重置。
      waitRounds: continuing && Number.isSafeInteger(previous.waitRounds) ? previous.waitRounds : 0,
      dispatchFailures: 0,
      reused: pending.reused === true,
      reuseCount: Number.isSafeInteger(pending.reuseCount) ? pending.reuseCount : 0,
      waitProbes: 0,
      openMrs: Array.isArray(pending.openMrs)
        ? pending.openMrs
        : (Array.isArray(previous?.openMrs) ? previous.openMrs : []),
      item: { ...item, body: '' },
      closure: '',
      closureNote: '',
      nextAttemptAt: null,
      replied: null,
      reportStatus: '',
      reportSummary: '',
      resumeAfterMinutes: null,
    };
    this.state.handled[todoId] = record;
    delete this.state.pending[todoId];
    this.state.recent = [record, ...this.state.recent.filter((entry) => entry.id !== todoId)].slice(0, 50);
    return record;
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
        // 已完成/失败记录不参与“会话仍在跑”的接管；共享会话因别的任务 running
        // 也不能把历史 Todo 重新挂回跟踪表，否则会重复结算并永久占槽。
        if (record?.sessionId && record.executionStatus === 'running'
          && (record.automatic !== false || record.routed === true)) {
          owned.set(record.id, {
            sessionId: record.sessionId,
            todoId: record.id,
            startedAt: record.acceptedAt,
            requestId: record.requestId ?? '',
            automatic: record.automatic !== false,
            countsSlot: record.automatic !== false,
            // 状态里仍是 running 却没人跟踪：上次运行被重启打断的遗留记录，需要接管结算。
            orphaned: record.executionStatus === 'running',
          });
        }
      }
      for (const record of Object.values(this.state.pending)) {
        if (record?.sessionId && record.item?.id && (record.automatic !== false || record.routed === true)) {
          owned.set(record.item.id, {
            sessionId: record.sessionId,
            todoId: record.item.id,
            startedAt: record.createdAt,
            requestId: record.requestId ?? '',
            automatic: record.automatic !== false,
            countsSlot: record.automatic !== false,
            // pending 无论名册 running/idle 都要读历史：响应丢失时它可能已经执行完。
            orphaned: true,
          });
        }
      }
      // 重启恢复：按 Todo 逐条接管。名册报告 running 的自动任务占并发槽；
      // 状态停在 running 的遗留记录不占槽，只为结算，避免永远悬空。
      for (const record of owned.values()) {
        const tracked = this.trackedSessions.get(record.sessionId);
        if (tracked?.todos.has(record.todoId)) continue;
        const running = byId.get(record.sessionId)?.running === true;
        if (running) {
          this.trackSession(record.sessionId, record.todoId, record.startedAt, record.countsSlot, record.requestId);
        } else if (record.orphaned && !this.dispatches.has(record.todoId)) {
          this.trackSession(record.sessionId, record.todoId, record.startedAt, false, record.requestId);
        }
      }

      let changed = false;
      let settled = false;
      for (const [sessionId, tracked] of [...this.trackedSessions]) {
        const summary = byId.get(sessionId);
        const requests = [...tracked.todos.entries()].map(([todoId, entry]) => {
          const handled = this.state.handled[todoId];
          const originUrl = handled?.sessionId === sessionId ? handled.url : this.state.pending[todoId]?.item?.url;
          return { key: todoId, requestId: entry.requestId, startedAt: entry.startedAt, originUrl };
        });
        const inspections = await this.host.inspectRequests(sessionId, summary, requests);
        if (summary?.running) continue;

        const pending = [...inspections.values()].filter((inspection) => inspection?.outcome === 'pending');
        tracked.unreadablePolls = pending.some((inspection) => inspection.unreadable) ? tracked.unreadablePolls + 1 : 0;
        // 会话空闲但消息没落档/没有回合结束记录：可能是重启中断，也可能是队列丢失。
        // 正在执行 dispatch 的 Todo 不计入，避免提示词尚未送达时误结算。
        const idlePending = requests.some((request) => {
          const inspection = inspections.get(request.key);
          return (inspection?.idle || inspection?.awaitingMessage) && !this.dispatches.has(request.key);
        });
        tracked.idlePolls = idlePending ? tracked.idlePolls + 1 : 0;
        const unreadableTimeout = tracked.unreadablePolls >= 24;
        const idleTimeout = tracked.idlePolls >= IDLE_SETTLE_POLLS;

        for (const [todoId, entry] of [...tracked.todos]) {
          const inspection = inspections.get(todoId) ?? { outcome: 'pending', unreadable: true, reason: '结算响应缺少该 Todo。' };
          if (inspection.outcome === 'pending') {
            if (unreadableTimeout) {
              inspection.outcome = 'failed';
              inspection.error = `会话空闲但执行历史持续不可读：${inspection.reason ?? '未知原因'}`;
            } else if (idleTimeout && (inspection.idle || inspection.awaitingMessage)) {
              inspection.outcome = 'failed';
              inspection.error = inspection.awaitingMessage
                ? '会话空闲但路由消息未落档（排队消息丢失或被重启中断）'
                : '会话空闲但没有回合结束记录（回合未启动或被重启中断）';
            } else {
              continue;
            }
          }
          const pendingRecord = this.state.pending[todoId];
          let handled = this.state.handled[todoId];
          if (pendingRecord && handled && !handled.sessionId && handled.outcome !== 'session-accepted') {
            // 兼容旧版本竞争：预检/规则已给出无会话结论时不被 pending 恢复覆盖。
            // 新版本的轮询候选已排除 pending，不会再次产生这种竞争。
            delete this.state.pending[todoId];
            changed = true;
            this.untrackTodo(sessionId, todoId);
            continue;
          }
          const pendingSupersedesHandled = pendingRecord?.sessionId === sessionId && (!handled
            || handled.sessionId !== sessionId
            || (pendingRecord.requestId && handled.requestId !== pendingRecord.requestId));
          let materialized = false;
          if (pendingSupersedesHandled
            && (inspection.messageAccepted === true || inspection.outcome === 'cancelled')) {
            handled = this.materializePendingRecord(todoId, pendingRecord);
            materialized = true;
          }
          if (pendingSupersedesHandled && !materialized) {
            if (!pendingRecord.requestId) {
              // v4 及更早 pending 没有幂等标识：无法确认旧消息是否入队时，
              // 转人工而不是生成新 requestId 重发（可能双执行）。
              handled = this.materializePendingRecord(todoId, pendingRecord);
              handled.executionStatus = 'failed';
              handled.completedAt = Date.now();
              handled.executionError = '旧版 pending 缺少 requestId，无法确认原消息是否已被 Host 接受';
              handled.closure = 'needs-human';
              handled.closureNote = '已停止自动重试以避免重复执行；请人工核对原会话后决定是否重新处理';
              handled.pendingUnconfirmed = true;
              handled.nextAttemptAt = null;
              changed = true;
            }
            // pending 尚未证实被接受时，绝不能把本次 inspection 错算到上一轮 handled。
            this.untrackTodo(sessionId, todoId);
            continue;
          }
          if (handled?.sessionId === sessionId) {
            if (this.state.pending[todoId]?.sessionId === sessionId) delete this.state.pending[todoId];
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
          this.untrackTodo(sessionId, todoId);
        }
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
   * 初始 pending 的 Todo 已被外部完成：不能重试，也不能让 pending 永远 starting。
   * 未跟踪不等于未接受（响应可能丢失），因此只转“需人工核对”，不直接判定闭环。
   */
  cleanupExternallyDonePending(todos) {
    const pendingIds = new Set(todos.map((todo) => todo.id));
    let changed = false;
    for (const [todoId, pending] of Object.entries(this.state.pending)) {
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
  }

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
      const todoPending = pendingIds.has(record.id);
      if (record.closure === 'verifying') {
        if ((record.completedAt ?? 0) > fetchStartedAt) continue;
        await this.concludeRecord(record, todoPending);
        changed = true;
      } else if (!todoPending && record.replied !== false && record.pendingUnconfirmed !== true) {
        record.closure = 'closed';
        record.closureNote = 'Todo 已不在待办列表（已被标记完成）';
        record.nextAttemptAt = null;
        record.watch = null;
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
  }

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
  }

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
        const stdout = await this.runGlab(['api', '-X', 'GET', api, '-F', 'per_page=100', '-F', `page=${page}`]);
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
  }

  /** 是否有别的插件会话正在同一个 Issue/MR 上执行。 */
  targetBusy(todo) {
    const key = targetKey(todo?.url);
    if (!key) return false;
    for (const tracked of this.trackedSessions.values()) {
      for (const todoId of tracked.todos.keys()) {
        if (todoId === todo.id) continue;
        const url = this.state.handled[todoId]?.url ?? this.state.pending[todoId]?.item?.url;
        if (targetKey(url) === key) return true;
      }
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

  /**
   * 事件驱动续办：逐条核对“待续办 + waiting + openMrs”记录监视的 MR。
   * 状态从 running/未知翻转为流水线结果、合并或关闭时，把续办提前到本轮（nextAttemptAt=now），
   * 并清掉监视器（一次事件只触发一次；下一轮会话若仍 waiting 会重建）。
   * 定时续办不受影响，始终作为兜底。API 失败的 MR 跳过本轮。
   */
  async refreshWatches() {
    if (this.stopping) return { changed: false, triggered: false };
    let changed = false;
    let triggered = false;
    // 同一轮内按 API 路径去重：同一 MR 被多条记录监视时只请求一次。
    const detailCache = new Map();
    for (const record of Object.values(this.state.handled)) {
      if (record?.closure !== 'follow-up' || !Array.isArray(record.watch?.mrs) || record.watch.mrs.length === 0) continue;
      if (this.dispatches.has(record.id) || this.isTodoTracked(record.sessionId, record.id)) continue;
      let fired = false;
      for (const mrUrl of [...record.watch.mrs]) {
        const api = mrApiPath(mrUrl);
        if (!api) continue;
        let detail = detailCache.get(api);
        if (detail === undefined) {
          try {
            detail = JSON.parse(await this.runGlab(['api', '-X', 'GET', api]));
          } catch {
            detail = null;
          }
          detailCache.set(api, detail);
        }
        if (detail == null) continue;
        const state = mrWatchState(detail);
        const previous = record.watch.lastStates[mrUrl] ?? '';
        if (previous === state) continue;
        record.watch.lastStates[mrUrl] = state;
        changed = true;
        if (state === 'merged' || state === 'closed' || state.startsWith('pipeline:')) {
          fired = true;
          break;
        }
      }
      if (fired) {
        record.nextAttemptAt = Date.now();
        record.watch = null;
        triggered = true;
        this.ctx.logger?.info?.(`[gitlab-todo-agent] Todo ${record.id} 等待的 MR 状态翻转，提前触发续办。`);
      }
    }
    return { changed, triggered };
  }

  /**
   * 讨论串里“我方最后一条 note”之后是否出现他人的非系统 note（有人回应了我们的等待）。
   * true/false 为确定结论；无法判断（接口失败、没找到讨论串、我方没有回复）返回 null。
   */
  async checkThreadActivity(item) {
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
          let last = -1;
          for (let i = index + 1; i < notes.length; i += 1) {
            if (notes[i] && notes[i].system !== true && String(notes[i].author?.id ?? '') === this.gitlabUserId) last = i;
          }
          if (last < 0) return null;
          return notes.slice(last + 1).some((note) => note
            && note.system !== true
            && String(note.author?.id ?? '') !== this.gitlabUserId);
        }
        if (discussions.length < 100) break;
      }
    } catch (error) {
      this.ctx.logger?.warn?.(`[gitlab-todo-agent] 等待探测读取讨论串失败（${api}）：${errorMessage(error)}`);
    }
    return null;
  }

  /**
   * 纯等待续办的零 LLM 探测：到期的“waiting 续办”先用 glab 看一眼——监视的 MR 没有状态翻转、
   * 讨论串里也没人回应，就不开会话，直接把续办顺延一个等待周期，省下一整个会话的 token。
   * 只在能确证“没有变化”时才推迟；任何不确定（读取失败、监视器缺观测、补救类续办、
   * 连续推迟已达心跳上限）都放行给后续的续办会话。事件触发的续办（watch 已被清掉）不探测。
   */
  async probeWaitingFollowUps() {
    if (this.state.settings.waitProbeEnabled === false) return 0;
    const now = Date.now();
    let deferred = 0;
    for (const record of Object.values(this.state.handled)) {
      if (record?.closure !== 'follow-up' || !record.sessionId) continue;
      if (!Number.isFinite(record.nextAttemptAt) || record.nextAttemptAt > now) continue;
      if (record.reportStatus !== 'waiting' || record.executionStatus !== 'completed' || record.replied === false) continue;
      if (record.pendingUnconfirmed === true || (record.dispatchFailures ?? 0) > 0) continue;
      if (this.dispatches.has(record.id) || this.isTodoTracked(record.sessionId, record.id)) continue;
      const probes = Number.isSafeInteger(record.waitProbes) ? record.waitProbes : 0;
      if (probes >= WAIT_PROBE_MAX_DEFERS) continue;
      const item = record.item ?? this.state.todos.find((todo) => todo.id === record.id) ?? null;
      if (!item) continue;
      const openMrs = Array.isArray(record.openMrs) ? record.openMrs : [];
      if (openMrs.length > 0) {
        // 有 MR 要等：必须有仍在生效的监视器且每个被监视的 MR 至少成功观测过一次，
        // 否则“没翻转”是无证据的；watch 已被清掉说明刚发生过事件，必须开会话。
        const mrs = Array.isArray(record.watch?.mrs) ? record.watch.mrs : [];
        if (mrs.length === 0 || !mrs.every((url) => Boolean(record.watch.lastStates?.[url]))) continue;
      }
      const activity = await this.checkThreadActivity(item);
      if (activity !== false) continue;
      const base = this.state.settings.followUpDelayMinutes;
      const suggested = Number.isFinite(record.resumeAfterMinutes) ? record.resumeAfterMinutes : 0;
      const delayMinutes = Math.max(2, Math.min(Math.max(base, suggested), 360));
      record.waitProbes = probes + 1;
      record.nextAttemptAt = Date.now() + delayMinutes * 60000;
      record.lastProbeAt = Date.now();
      deferred += 1;
      this.ctx.logger?.info?.(`[gitlab-todo-agent] Todo ${record.id} 等待探测无变化，推迟续办 ${delayMinutes} 分钟（第 ${record.waitProbes} 次，未开会话）。`);
    }
    return deferred;
  }

  /** 把到期的续办排进派发队列；同一对象上有别的会话在跑时顺延到下一轮。 */
  enqueueFollowUps() {
    const now = Date.now();
    const queued = new Set(this.dispatchQueue.map((entry) => entry.todo.id));
    for (const record of Object.values(this.state.handled)) {
      if (record?.closure !== 'follow-up' || !record.sessionId) continue;
      if (!Number.isFinite(record.nextAttemptAt) || record.nextAttemptAt > now) continue;
      if (queued.has(record.id) || this.dispatches.has(record.id) || this.isTodoTracked(record.sessionId, record.id)) continue;
      const item = record.item ?? this.state.todos.find((todo) => todo.id === record.id) ?? null;
      if (!item) {
        record.closure = 'needs-human';
        record.closureNote = `${record.closureNote}；缺少 Todo 数据，无法续办`.replace(/^；/, '');
        record.nextAttemptAt = null;
        record.watch = null;
        continue;
      }
      // 链路超龄（如长期被同目标会话占住而无限顺延）：转需人工，不再自动续办。
      if (Date.now() - (record.firstAcceptedAt ?? record.acceptedAt ?? 0) > FOLLOW_UP_MAX_AGE_MS) {
        record.closure = 'needs-human';
        record.closureNote = `${record.closureNote}；超出自动续办时限，转人工接手`.replace(/^；/, '');
        record.nextAttemptAt = null;
        record.watch = null;
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

  /** 自动 pending 跳过预检直接重试；复用原会话/requestId，手动 pending 不在后台自动重试。 */
  enqueuePendingRetries() {
    const queued = new Set(this.dispatchQueue.map((entry) => entry.todo.id));
    let count = 0;
    for (const [todoId, pending] of Object.entries(this.state.pending)) {
      if (pending?.automatic === false || !pending?.requestId || queued.has(todoId) || this.dispatches.has(todoId)) continue;
      const handled = this.state.handled[todoId];
      if (pending.followUp === true && Number.isFinite(handled?.nextAttemptAt) && handled.nextAttemptAt > Date.now()) continue;
      if (handled && !handled.sessionId && handled.outcome !== 'session-accepted') continue;
      const followUp = pending.followUp === true;
      const todo = this.state.todos.find((item) => item.id === todoId) ?? (followUp ? pending.item : null);
      // 非续办 Todo 已被外部标记完成时不再重复执行，留给闭环核对清理。
      if (!todo) continue;
      this.dispatchQueue.push({ todo, followUp, pendingRetry: true });
      queued.add(todoId);
      count += 1;
    }
    if (count > 0) this.ensureSessionTimer();
    return count;
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
        .filter((todo) => !this.dispatches.has(todo.id) && !this.state.pending[todo.id]);
      this.state.lastNewCount = candidates.length;
      if (this.state.settings.enabled && this.state.settings.autoProcess) {
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
      this.activeChildren.add(child);
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
        this.activeChildren.delete(child);
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

  async routeById(id, sessionId) {
    const todo = this.state.todos.find((item) => item.id === id);
    if (!todo) return { ok: false, error: '当前轮询结果中找不到该 Todo，请先重新检查。' };
    if (typeof sessionId !== 'string' || !sessionId.trim()) return { ok: false, error: '缺少目标 sessionId。' };
    return this.dispatch(todo, Boolean(this.state.handled[id]), { route: { sessionId: sessionId.trim() } });
  }

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
  }

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
  }

  /** 手动路由选择器数据。只列可投递的顶层会话，并附带负载与同目标标记。 */
  async routeTargets(todoId = '') {
    const value = await this.host.listSessions();
    if (!Array.isArray(value?.items)) throw new Error('session/list 响应缺少 items 数组。');
    const owned = this.pluginCreatedSessionIds();
    const archived = this.archivedSessionIds();
    const scope = this.state.settings.routeScope;
    const todo = this.state.todos.find((item) => item.id === todoId);
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
  }

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
  }

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
  }

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
  }

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
    if (item) {
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
  }

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
    // 任务类型：预检判定优先（parseBatchJudgeReply 已把 other 归并为空串）；续办沿用上一轮分类；未分类（''）跟随会话模型。
    const taskType = judge?.taskType
      ? judge.taskType
      : (continuing ? (previous?.taskType ?? '') : '');
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
          taskType,
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
          taskType,
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
          taskType,
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
        // 按任务类型选模型：预检分类命中且配置了映射时优先，否则用会话模型；路由会话不改模型。
        const typeModel = taskType ? (this.state.settings.taskModels?.[taskType] ?? null) : null;
        const modelSelection = typeModel ?? this.state.settings.sessionModel;
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
          text: buildTodoPrompt(todo, {
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
        taskType,
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
      if (body.action === 'inbox') {
        // 需人工收件箱：未确认的 needs-human 记录全集（面板轮询刷新）。
        return jsonResponse(200, { ok: true, items: buildInbox(this.state) });
      }
      if (body.action === 'acknowledge' && (typeof body.todoId === 'string' || typeof body.todoId === 'number')) {
        const result = await this.acknowledgeNeedsHuman(String(body.todoId));
        return jsonResponse(200, { ok: true, result, state: this.snapshot() });
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
      if (body.action === 'routeTargets') {
        return jsonResponse(200, { ok: true, ...(await this.routeTargets(typeof body.todoId === 'string' ? body.todoId : '')) });
      }
      if (body.action === 'route' && (typeof body.id === 'string' || typeof body.id === 'number')) {
        const result = await this.routeById(String(body.id), body.sessionId);
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
