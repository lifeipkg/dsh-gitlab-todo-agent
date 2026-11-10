import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTodoPrompt,
  classifyTodo,
  initialState,
  normalizeState,
  normalizeTodos,
  publicState,
  selectPendingTodos,
  STATE_VERSION,
  validateSettings,
} from './core.js';

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STORAGE_DIRECTORY = join(homedir(), '.dsh-plugins', 'gitlabtodo');
const LEGACY_STATE_FILE = join(PACKAGE_DIR, '.runtime', 'state.json');
const TODO_PAGE_SIZE = 100;
const MAX_TODO_PAGES = 20;
const BRIDGE_PATH = '/api/gitlab-todo-agent';
const MAX_REQUEST_BYTES = 128 * 1024;

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
    this.trackedSessions = new Map();
    this.slotReservations = 0;
    this.statusWaiters = new Set();
    this.statusEventsAvailable = false;
    this.removeStatusListeners = [];
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
    this.installSessionStatusListeners();
    this.resetTimer();
  }

  installSessionStatusListeners() {
    if (typeof this.ctx.on !== 'function') return;
    const onStatus = (sessionId, running) => {
      if (typeof sessionId !== 'string' && typeof sessionId !== 'number') return;
      if (!this.trackedSessions.has(String(sessionId))) return;
      if (running === false) this.untrackSession(String(sessionId));
    };
    const onRemoved = (sessionId) => {
      if (typeof sessionId === 'string' || typeof sessionId === 'number') {
        this.untrackSession(String(sessionId));
      }
    };
    try {
      this.removeStatusListeners.push(this.ctx.on('api-session/status', onStatus));
      this.removeStatusListeners.push(this.ctx.on('api-session/removed', onRemoved));
      this.statusEventsAvailable = true;
    } catch (error) {
      this.ctx.logger?.warn?.(`[gitlab-todo-agent] 订阅 Session 状态失败：${errorMessage(error)}`);
    }
  }

  async stop() {
    this.stopping = true;
    this.dispatchQueue = [];
    this.wakeWaiters();
    clearInterval(this.timer);
    clearTimeout(this.initialTimer);
    if (this.unregisterRoute) await this.unregisterRoute();
    this.unregisterRoute = null;
    for (const dispose of this.removeStatusListeners.splice(0)) {
      try { dispose?.(); } catch {}
    }
    this.activeChild?.kill();
    await Promise.allSettled([
      this.pumpPromise?.catch(() => {}),
      this.writeChain.catch(() => {}),
    ]);
  }

  snapshot() {
    return {
      ...publicState(this.state, Boolean(this.pollPromise), this.gitlabUserId),
      activeSessions: this.trackedSessions.size,
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

  concurrencyLimit() {
    const value = Number(this.state?.settings?.maxConcurrentSessions);
    return Number.isSafeInteger(value) && value >= 1 ? Math.min(value, 10) : 2;
  }

  occupiedSlots() {
    return this.trackedSessions.size + this.slotReservations;
  }

  hasFreeSlot() {
    return this.occupiedSlots() < this.concurrencyLimit();
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

  trackSession(sessionId) {
    if (!sessionId || this.trackedSessions.has(sessionId)) return;
    this.trackedSessions.set(sessionId, Date.now());
  }

  untrackSession(sessionId) {
    if (this.trackedSessions.delete(sessionId)) this.wakeWaiters();
  }

  async refreshTrackedSessions() {
    const list = this.ctx.sessionController?.list;
    if (typeof list !== 'function' || this.trackedSessions.size === 0) return;
    let value;
    try {
      value = await list({}, new AbortController().signal);
    } catch {
      return;
    }
    const items = Array.isArray(value?.items) ? value.items : [];
    const byId = new Map();
    for (const item of items) {
      if (item?.sessionId) byId.set(String(item.sessionId), item);
    }
    const now = Date.now();
    const graceMs = Number.isFinite(this.config.slotGraceMs) ? Math.max(0, this.config.slotGraceMs) : 15000;
    for (const [sessionId, trackedAt] of [...this.trackedSessions]) {
      const summary = byId.get(sessionId);
      if (!summary) {
        this.untrackSession(sessionId);
        continue;
      }
      if (!this.statusEventsAvailable && summary.running === false && now - trackedAt > graceMs) {
        this.untrackSession(sessionId);
      }
    }
  }

  enqueueDispatch(todos) {
    if (!Array.isArray(todos) || todos.length === 0) return;
    const queued = new Set(this.dispatchQueue.map((todo) => todo.id));
    for (const todo of todos) {
      if (queued.has(todo.id) || this.dispatches.has(todo.id) || this.state.handled[todo.id]) continue;
      this.dispatchQueue.push(todo);
    }
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
        void this.refreshTrackedSessions();
        await this.waitForSlotSignal();
        continue;
      }
      const todo = this.dispatchQueue.shift();
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
      const todos = await this.fetchTodos();
      this.state.todos = todos;
      this.state.lastSuccessAt = Date.now();
      const candidates = selectPendingTodos(todos, this.state.handled, todos.length)
        .filter((todo) => !this.dispatches.has(todo.id));
      this.state.lastNewCount = candidates.length;
      if (this.state.settings.enabled && this.state.settings.autoProcess) {
        const directMentions = candidates
          .filter((todo) => classifyTodo(todo, this.gitlabUserId) === 'direct-mention')
          .slice(0, this.state.settings.maxSessionsPerPoll);
        this.enqueueDispatch(directMentions);
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

  async dispatchById(id) {
    const todo = this.state.todos.find((item) => item.id === id);
    if (!todo) return { ok: false, error: '当前轮询结果中找不到该 Todo，请先重新检查。' };
    return this.dispatch(todo, Boolean(this.state.handled[id]));
  }

  async dispatch(todo, force = false, options = {}) {
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

  async executeDispatch(todo, force, options = {}) {
    const trackSlot = Boolean(options.trackSlot);
    let sessionId = force ? null : this.state.pending[todo.id]?.sessionId;
    let reserved = false;
    try {
      if (classifyTodo(todo, this.gitlabUserId) === 'merge-request') {
        await this.markTodoDone(todo);
        const record = {
          id: todo.id,
          sessionId: null,
          outcome: 'merge-request-done',
          acceptedAt: Date.now(),
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
      if (sessionId) this.trackSession(sessionId);
      if (!sessionId) {
        const request = {};
        if (this.state.settings.sessionCwd) request.cwd = this.state.settings.sessionCwd;
        if (typeof this.config.agentPreset === 'string' && this.config.agentPreset) {
          request.agentPreset = this.config.agentPreset;
        }
        const created = await this.ctx.sessionController.create(request);
        sessionId = created.sessionId;
        this.trackSession(sessionId);
        this.state.pending[todo.id] = {
          sessionId,
          createdAt: Date.now(),
          item: todo,
        };
        await this.persistQuietly('pending Session');
      }
      if (reserved) {
        this.releaseReservation();
        reserved = false;
      }
      if (this.state.settings.sessionModel) {
        await this.ctx.sessionController.selectModel({
          sessionId,
          ...this.state.settings.sessionModel,
        });
      }
      await this.ctx.sessionController.prompt({
        requestId: `gitlab-todo-${randomUUID()}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: buildTodoPrompt(todo) }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, new AbortController().signal);
      const record = {
        id: todo.id,
        sessionId,
        outcome: 'session-accepted',
        acceptedAt: Date.now(),
        title: todo.title,
        url: todo.url,
        project: todo.project,
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
      if (trackSlot && sessionId) this.untrackSession(sessionId);
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
        return jsonResponse(200, { ok: true, catalog: await this.ctx.sessionController.modelCatalog() });
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
      if (body.action === 'poll') {
        const state = await this.poll('manual');
        return jsonResponse(200, { ok: true, state });
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

export const inject = ['connection', 'sessionController'];

export function apply(ctx, config = {}) {
  const runtime = new GitlabTodoRuntime(ctx, config);
  return ctx.effect(async () => {
    await runtime.start();
    return () => runtime.stop();
  }, 'gitlab-todo-agent: runtime');
}
