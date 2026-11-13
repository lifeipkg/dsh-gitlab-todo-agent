import {
  discussionsApiPath,
  mrApiPath,
  mrWatchState,
  targetKey,
} from '../core.js';
import {
  FOLLOW_UP_MAX_AGE_MS,
  MAX_DISCUSSION_PAGES,
  WAIT_PROBE_MAX_DEFERS,
} from './constants.js';
import { errorMessage } from './util.js';

/**
 * 续办生命周期：MR 事件监视（提前触发）、讨论串活动探测（无变化顺延）、
 * 到期入队、pending 幂等重试。
 * 挂到 GitlabTodoRuntime 原型上，this 指向运行时实例。
 */
export const followupsMethods = {

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
  },

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
        this.logger.info(`Todo ${record.id} 等待的 MR 状态翻转，提前触发续办。`);
      }
    }
    return { changed, triggered };
  },

  /**
   * 讨论串里“我方最后一条 note”之后是否出现他人的非系统 note（有人回应了我们的等待）。
   * true/false 为确定结论；无法判断（接口失败、没找到讨论串、我方没有回复）返回 null。
   */
  async checkThreadActivity(item) {
    const api = discussionsApiPath(item?.url);
    if (!api || !item?.noteId || !this.gitlabUserId) return null;
    try {
      for (let page = 1; page <= MAX_DISCUSSION_PAGES; page += 1) {
        const stdout = await this.runGlab(['api', '-X', 'GET', api, '-F', 'per_page=100', '-F', `page=${page}`, '-F', 'order_by=updated_at', '-F', 'sort=desc']);
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
      this.logger.warn(`等待探测读取讨论串失败（${api}）：${errorMessage(error)}`);
    }
    return null;
  },

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
      this.logger.info(`Todo ${record.id} 等待探测无变化，推迟续办 ${delayMinutes} 分钟（第 ${record.waitProbes} 次，未开会话）。`);
    }
    return deferred;
  },

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
  },

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
  },
};
