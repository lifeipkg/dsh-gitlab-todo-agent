import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DshHostClient } from './dsh-host.js';
import {
  buildInbox,
  createLogBuffer,
  handledPage,
  initialState,
  normalizeState,
  publicState,
  STATE_VERSION,
  validateSettings,
} from './core.js';
import {
  BRIDGE_PATH,
  LOG_MAX_CHARS,
  LOG_MAX_ENTRIES,
  LOG_MAX_LINE_CHARS,
  MAX_REQUEST_BYTES,
} from './host/constants.js';
import { attachRuntimeMethods, errorMessage, jsonResponse } from './host/util.js';
import { gitlabMethods } from './host/gitlab.js';
import { issuesMethods } from './host/issues.js';
import { logsMethods } from './host/logs.js';
import { precheckMethods } from './host/precheck.js';
import { precheckJevMethods } from './host/precheck-jev.js';
import { slotsMethods } from './host/slots.js';
import { closuresMethods } from './host/closures.js';
import { followupsMethods } from './host/followups.js';
import { dispatchMethods } from './host/dispatch.js';

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STORAGE_DIRECTORY = join(homedir(), '.dsh-plugins', 'gitlabtodo');
const LEGACY_STATE_FILE = join(PACKAGE_DIR, '.runtime', 'state.json');

/**
 * 运行时骨架：状态生命周期（加载/迁移/持久化）、轮询与对账定时器、bridge 入口。
 * 业务方法按域拆分在 host/*.js，启动时 attachRuntimeMethods 挂到本类原型：
 *   host/gitlab.js    glab 子进程、当前用户、Todo/Issue 分页、标记完成、Issue 状态核对
 *   host/issues.js    Issue 面板（刷新“指派给我的开放 Issue”缓存、面板投影）
 *   host/logs.js      运行时内存日志（Log Tab 投影、清空）
 *   host/precheck.js  预检调度（LLM 单条 + 批量 + 失败降级 + 引擎选择）
 *   host/precheck-jev.js  Jev/System One 分类器预检（宿主 classify → jev CLI → HTTP 三层通道）
 *   host/slots.js     并发槽、会话跟踪、对账结算（reconcile）
 *   host/closures.js  闭环裁决（verifySettled / assessClosures / 归档 / 回复核对）
 *   host/followups.js 续办生命周期（MR 监视、等待探测、到期入队、pending 重试）
 *   host/dispatch.js  派发管线（poll/pump/dispatch）、路由、手动动作、工作区总览
 * 模块方法仍用 this.* 互调，与拆分前同一个实例；新增业务方法请放进对应域模块，
 * 不要再往这个类里堆。
 */
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
    // 本轮批量预检的判定（todoId → verdict）：派发时消费（preferSession 决定路由、priority 排序）。
    this.judgeVerdicts = new Map();
    // 预检连续失败计数（todoId → 次数）：失败本轮跳过，获得判定或被处理后清零。
    this.precheckFailures = new Map();
    this.lastJudgeError = '';
    // 运行时内存日志（Log Tab）：只进内存环形缓冲（条数/总字符双封顶、单行截断），不落盘。
    // this.logger.<level>() 统一入口：进缓冲 + 透传宿主 logger（自动补 [gitlab-todo-agent] 前缀）。
    // 消息规范：单行「<对象/动作>：<结果/细节>」，不要在业务代码里自己加前缀。
    this.logs = createLogBuffer({
      maxEntries: LOG_MAX_ENTRIES,
      maxChars: LOG_MAX_CHARS,
      maxLineChars: LOG_MAX_LINE_CHARS,
    });
    const upstream = this.ctx.logger ?? {};
    this.logger = {};
    for (const level of ['debug', 'info', 'warn', 'error']) {
      this.logger[level] = (message) => {
        // 历史调用点自带 [gitlab-todo-agent] 前缀：缓冲里剥掉保持整洁，透传时再补回。
        const entry = String(message ?? '').replace(/^\s*\[gitlab-todo-agent\]\s*/u, '');
        this.logs.push(level, entry);
        try { upstream[level]?.(`[gitlab-todo-agent] ${entry}`); } catch { /* 宿主日志失败不影响业务 */ }
      };
    }
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
    this.logger.info(`运行时已启动：${this.state.settings.enabled ? `自动轮询开启（间隔 ${this.state.settings.intervalSeconds}s）` : '自动轮询关闭（仅手动动作）'}。`);
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
      this.logger.warn(message);
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
    // 分类器 apiKey 不回传面板：补丁里缺该字段时保留已存密钥，显式传 '' 才清除。
    const merged = { ...(patch ?? {}) };
    if (merged.precheckClassifier && typeof merged.precheckClassifier === 'object') {
      const stored = this.state.settings.precheckClassifier;
      const touched = Object.prototype.hasOwnProperty.call(merged.precheckClassifier, 'apiKey');
      if (!touched && stored?.apiKey) {
        merged.precheckClassifier = { ...merged.precheckClassifier, apiKey: stored.apiKey };
      }
    }
    const next = validateSettings(merged, this.state.settings);
    this.state.settings = next;
    await this.persistQuietly('设置');
    this.resetTimer();
    this.wakeWaiters();
    return this.snapshot();
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
      if (request.method === 'GET' && url.searchParams.get('action') === 'issues') {
        // Issue 面板：读缓存投影（不发 glab）；刷新走 POST issues {refresh:true}。
        return jsonResponse(200, { ok: true, ...this.issueProjection() });
      }
      if (request.method === 'GET' && url.searchParams.get('action') === 'logs') {
        // 运行时内存日志：只读快照（新→旧）。清空走 POST logs {clear:true}。
        return jsonResponse(200, { ok: true, ...this.logProjection() });
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
      if (body.action === 'issues') {
        // Issue 面板：refresh 显式重拉 GitLab（慢操作，90s bridge 超时内）；否则返回缓存投影。
        const projection = body.refresh === true ? await this.refreshIssues() : this.issueProjection();
        return jsonResponse(200, { ok: true, ...projection });
      }
      if (body.action === 'logs') {
        // Log Tab：clear 清空缓冲（并留一条审计行）；否则返回当前投影。
        if (body.clear === true) this.clearLogEntries();
        return jsonResponse(200, { ok: true, ...this.logProjection() });
      }
      if (body.action === 'poll') {
        const state = await this.poll('manual');
        return jsonResponse(200, { ok: true, state });
      }
      if (body.action === 'inbox') {
        // 需人工收件箱：未确认的 needs-human 记录全集（面板轮询刷新）。
        return jsonResponse(200, { ok: true, items: buildInbox(this.state) });
      }
      if (body.action === 'handled') {
        // “已处理”分页：不过滤跳过项，让规则/预检判定在面板上可见。默认 50 条/页。
        return jsonResponse(200, { ok: true, ...handledPage(this.state, body.offset, body.limit) });
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

// 挂载各域方法集；同名冲突会在加载期直接报错，不会静默覆盖。
attachRuntimeMethods(GitlabTodoRuntime, [
  gitlabMethods,
  issuesMethods,
  logsMethods,
  precheckMethods,
  precheckJevMethods,
  slotsMethods,
  closuresMethods,
  followupsMethods,
  dispatchMethods,
]);

export const inject = ['connection', 'typertGateway', 'workspaceRegistry'];

export function apply(ctx, config = {}) {
  const runtime = new GitlabTodoRuntime(ctx, config);
  return ctx.effect(async () => {
    await runtime.start();
    return () => runtime.stop();
  }, 'gitlab-todo-agent: runtime');
}
