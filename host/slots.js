import { buildSessionTitle, normalizeMrUrls } from '../core.js';
import { IDLE_SETTLE_POLLS } from './constants.js';
import { errorMessage } from './util.js';

/**
 * 并发槽与会话跟踪：槽位记账、track/untrack、对账结算（reconcile）。
 * 挂到 GitlabTodoRuntime 原型上，this 指向运行时实例。
 */
export const slotsMethods = {

  concurrencyLimit() {
    const value = Number(this.state?.settings?.maxConcurrentSessions);
    return Number.isSafeInteger(value) && value >= 1 ? Math.min(value, 10) : 2;
  },

  occupiedSlots() {
    // 并发按“有自动任务的会话”计数：同会话多条自动 Todo 不重复占槽，
    // 首条结算后，只要还有自动路由任务未结算，该会话仍持有一个槽。
    const tracked = [...this.trackedSessions.values()]
      .filter((record) => [...record.todos.values()].some((entry) => entry.countsSlot)).length;
    return tracked + this.slotReservations;
  },

  hasFreeSlot() {
    return this.sessionRosterKnown && this.occupiedSlots() < this.concurrencyLimit();
  },

  sessionPollMs() {
    return Number.isFinite(this.config.sessionPollMs) ? Math.max(20, this.config.sessionPollMs) : 3000;
  },

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
  },

  wakeWaiters() {
    const waiters = [...this.statusWaiters];
    this.statusWaiters.clear();
    for (const wake of waiters) wake();
  },

  slotWaitMs() {
    return Number.isFinite(this.config.slotWaitMs) ? Math.max(10, this.config.slotWaitMs) : 3000;
  },

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
  },

  reserveSlot() {
    this.slotReservations += 1;
  },

  releaseReservation() {
    this.slotReservations = Math.max(0, this.slotReservations - 1);
    this.wakeWaiters();
  },

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
  },

  /** 只解除一个 Todo 在该会话上的跟踪；会话上没有其他待结算消息时一并停表。 */
  untrackTodo(sessionId, todoId) {
    const record = this.trackedSessions.get(sessionId);
    if (!record) return;
    if (record.todos.delete(todoId)) this.wakeWaiters();
    if (record.todos.size === 0) this.untrackSession(sessionId);
    else this.ensureSessionTimer();
  },

  untrackSession(sessionId) {
    if (this.trackedSessions.delete(sessionId)) this.wakeWaiters();
    this.ensureSessionTimer();
  },

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
  },

  isTodoTracked(sessionId, todoId) {
    return this.trackedSessions.get(sessionId)?.todos.has(todoId) === true;
  },

  reconcileSessions() {
    if (this.reconcilePromise) return this.reconcilePromise;
    const operation = this.executeReconcile().finally(() => {
      if (this.reconcilePromise === operation) this.reconcilePromise = null;
    });
    this.reconcilePromise = operation;
    return operation;
  },

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
  },

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
      this.logger.warn(`会话状态核对失败：${errorMessage(error)}`);
    } finally {
      this.ensureSessionTimer();
    }
  },
};
