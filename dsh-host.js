import { randomUUID } from 'node:crypto';
import { CLOSURE_MARKER, parseClosureReport } from './core.js';

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function wireArgs(namespace, method, request) {
  if (namespace === 'session' && method === 'modelCatalog') return {};
  if (namespace === 'session' && method === 'list') return { _request: request };
  return { request };
}

function turnFailure(data) {
  const kind = data?.reason?.kind;
  if (kind === 'completed') return null;
  return typeof kind === 'string' ? kind : 'unknown';
}

/** 助手消息里的全部正文文本：优先 content 中的 text 块，退回递归收集字符串。 */
function assistantTexts(message) {
  const content = Array.isArray(message?.content) ? message.content : null;
  if (content) {
    const texts = content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text);
    if (texts.length > 0) return texts;
  }
  const out = [];
  const visit = (value, depth) => {
    if (out.length >= 200 || depth > 6) return;
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) for (const entry of value) visit(entry, depth + 1);
    else if (value && typeof value === 'object') for (const entry of Object.values(value)) visit(entry, depth + 1);
  };
  visit(message, 0);
  return out;
}

/** 一条助手文本里可能有多份报告；逐 marker 切片解析，支持共享回合按 todoId 归因。 */
function closureReports(source, originUrl) {
  const reports = [];
  let cursor = source.indexOf(CLOSURE_MARKER);
  while (cursor >= 0) {
    const next = source.indexOf(CLOSURE_MARKER, cursor + CLOSURE_MARKER.length);
    const report = parseClosureReport(source.slice(cursor, next >= 0 ? next : undefined), originUrl);
    if (report) reports.push(report);
    cursor = next;
  }
  return reports;
}

/**
 * 在本次执行的助手消息里找最后一份结案报告（[TODO-CLOSURE] {...}）。
 * todoId 给出时只接受同 ID 报告；missingTodoIdOnly 用于旧格式兜底，避免共享回合串报。
 */
function findClosureReport(events, startedAt, originUrl, options = {}) {
  const messages = events
    .filter((event) => event?.type === 'assistant/message' && (startedAt <= 0 || event.time >= startedAt))
    .sort((a, b) => b.seq - a.seq);
  for (const event of messages) {
    const texts = assistantTexts(event.data?.message);
    for (let index = texts.length - 1; index >= 0; index -= 1) {
      if (!texts[index].includes(CLOSURE_MARKER)) continue;
      const reports = closureReports(texts[index], originUrl);
      for (let reportIndex = reports.length - 1; reportIndex >= 0; reportIndex -= 1) {
        const report = reports[reportIndex];
        if (options.todoId && report.todoId !== options.todoId) continue;
        if (options.missingTodoIdOnly && report.todoId) continue;
        return report;
      }
    }
  }
  return null;
}

/** user/message 事件上插件 prompt 的关联键（Host 把 prompt requestId 持久化为 source.rpcId）。 */
function messageRpcId(event) {
  const source = event?.data?.source ?? event?.data?.message?.source;
  return source && typeof source.rpcId === 'string' ? source.rpcId : '';
}

/**
 * 按请求定位各自的回合结束与结案报告。
 * - 带 requestId：先定位 source.rpcId 匹配的 user/message，再取其 seq 之后第一个 turn/end。
 *   steer 可能在同一 turn 的下一步插入，因此多个请求可以共享 turn/end；
 *   报告优先按 todoId 精确归因，旧格式只允许落到下一条插件消息之前。
 * - 不带 requestId（旧记录兼容）：退回 startedAt 之后第一个 turn/end。
 */
function inspectRequestsFromEvents(events, requests) {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const results = new Map();
  for (const request of requests) {
    const startedAt = Number.isFinite(request.startedAt) && request.startedAt > 0 ? request.startedAt : 0;
    let fromSeq = 0;
    if (request.requestId) {
      const mine = sorted.find((event) => event?.type === 'user/message' && messageRpcId(event) === request.requestId);
      if (!mine) {
        // 消息尚未落档：running 时还在排队，idle 时可能丢失，都先保持 pending 由 idlePolls 兜底。
        results.set(request.key, { outcome: 'pending', awaitingMessage: true });
        continue;
      }
      fromSeq = mine.seq;
    }
    const turnEnd = sorted.find((event) => event?.type === 'turn/end' && event.seq > fromSeq
      && (request.requestId || startedAt <= 0 || event.time >= startedAt));
    if (!turnEnd) {
      // user/message 已落档就证明 Host 接受了 prompt，即使回合尚未结束；
      // idle 超时后调用方仍需据此 materialize pending，而不是重复投递。
      results.set(request.key, { outcome: 'pending', idle: true, messageAccepted: Boolean(request.requestId && fromSeq > 0) });
      continue;
    }
    const scoped = request.requestId
      ? sorted.filter((event) => event.seq > fromSeq && event.seq <= turnEnd.seq)
      : sorted.filter((event) => event.seq <= turnEnd.seq && (startedAt <= 0 || event.time >= startedAt));
    let report = null;
    if (request.requestId) {
      report = findClosureReport(scoped, 0, request.originUrl ?? '', { todoId: request.key });
      if (!report) {
        const nextPluginMessage = sorted.find((event) => event.seq > fromSeq
          && event?.type === 'user/message'
          && messageRpcId(event).startsWith('gitlab-todo-'));
        const legacyScoped = scoped.filter((event) => !nextPluginMessage || event.seq < nextPluginMessage.seq);
        report = findClosureReport(legacyScoped, 0, request.originUrl ?? '', { missingTodoIdOnly: true });
      }
    } else {
      report = findClosureReport(scoped, startedAt, request.originUrl ?? '');
    }
    const failure = turnFailure(turnEnd.data);
    results.set(request.key, {
      ...(failure === null
        ? { outcome: 'succeeded', report }
        : { outcome: 'failed', error: `Agent 回合未成功完成：${failure}`, report }),
      messageAccepted: true,
    });
  }
  return results;
}

/**
 * DSH Host 会话能力面。调用方式与 dsh-task-board 的 HostExecutionRunner 一致：
 * 全部经 typertGateway，以 Host 本地 owner peer 调用，不使用浏览器传入的身份。
 */
export class DshHostClient {
  constructor(ctx) {
    this.ctx = ctx;
    this.gateway = ctx.typertGateway;
    const controller = new AbortController();
    this.peer = {
      id: `gitlab-todo-owner:${randomUUID()}`,
      ctx,
      principal: { kind: 'owner' },
      signal: controller.signal,
      interactions: 'none',
      dispose: () => {
        controller.abort();
        return Promise.resolve();
      },
    };
  }

  invoke(method, request = {}, signal) {
    if (!this.gateway || typeof this.gateway.invoke !== 'function') {
      throw new Error('当前 Host 不提供 typertGateway.invoke，无法执行 DSH 会话操作。');
    }
    return this.gateway.invoke({
      namespace: 'session',
      method,
      args: wireArgs('session', method, request),
      peer: this.peer,
      ...(signal ? { signal } : {}),
    });
  }

  async stream(method, request, signal) {
    if (!this.gateway || typeof this.gateway.stream !== 'function') {
      throw new Error('当前 Host 不提供 typertGateway.stream，无法读取会话历史。');
    }
    return this.gateway.stream({
      namespace: 'session',
      method,
      args: { request },
      peer: this.peer,
      ...(signal ? { signal } : {}),
    });
  }

  modelCatalog() {
    return this.invoke('modelCatalog');
  }

  /**
   * 完整会话名册：跟随 cursor 分页读取全部已存储会话（session/list 默认每页 100）。
   * 只取一页会漏掉更早的会话；工作区总览依赖它枚举非插件会话。
   */
  async listSessions(options = {}) {
    const maxPages = Number.isSafeInteger(options.maxPages)
      ? Math.max(1, Math.min(options.maxPages, 50))
      : 20;
    const items = [];
    let cursor = null;
    for (let page = 0; page < maxPages; page += 1) {
      const value = await this.invoke('list', cursor ? { cursor } : {});
      if (!Array.isArray(value?.items)) throw new Error('session/list 响应缺少 items 数组。');
      items.push(...value.items);
      cursor = typeof value?.cursor === 'string' && value.cursor ? value.cursor : null;
      if (!cursor) break;
    }
    return { items };
  }

  async createSession(request) {
    const value = await this.invoke('create', request);
    if (typeof value?.sessionId !== 'string' || !value.sessionId) {
      throw new Error('DSH 创建会话响应缺少 sessionId。');
    }
    return value.sessionId;
  }

  selectModel(request) {
    return this.invoke('selectModel', request);
  }

  renameSession(sessionId, title) {
    return this.invoke('rename', { sessionId, title });
  }

  /**
   * 归档/取消归档会话：workspace 命名空间，owner-only。
   * 归档不带 stopActivity——仍有工作在跑的会话会被 Host 以 workspace/session-active 拒绝，
   * 调用方据此把失败记录下来而不是强行停止任何工作。
   */
   archiveSession(sessionId) {
    return this.workspaceArchiveCall('archiveSession', sessionId);
  }

  unarchiveSession(sessionId) {
    return this.workspaceArchiveCall('unarchiveSession', sessionId);
  }

  workspaceArchiveCall(method, sessionId) {
    if (!this.gateway || typeof this.gateway.invoke !== 'function') {
      throw new Error(`当前 Host 不提供 typertGateway.invoke，无法${method === 'archiveSession' ? '归档' : '恢复'}会话。`);
    }
    return this.gateway.invoke({
      namespace: 'workspace',
      method,
      args: { request: { sessionId } },
      peer: this.peer,
    });
  }

  prompt(request) {
    return this.invoke('prompt', request);
  }

  /**
   * 按 task-board 的执行结算方式读取一个会话：running=true 时仍在执行；
   * 空闲后从 follow 的开场帧与 page 历史中找到本次启动后的 turn/end。
   * requests 形如 [{key, requestId?, startedAt, originUrl?}]，返回 Map<key, inspection>。
   */
  async inspectRequests(sessionId, summary, requests, options = {}) {
    if (summary?.running) {
      return new Map(requests.map((request) => [request.key, { outcome: 'pending' }]));
    }
    if (!summary) {
      return new Map(requests.map((request) => [request.key, { outcome: 'cancelled', error: '执行会话已不存在。' }]));
    }

    let opening;
    const address = { kind: 'session', sessionId };
    try {
      const stream = await this.stream('follow', { address, maxMessages: 1 });
      const iterator = stream[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (typeof iterator.return === 'function') await iterator.return();
      opening = first.done ? null : first.value;
      if (opening?.type !== 'snapshot' || !Number.isSafeInteger(opening.cursor)
        || !Array.isArray(opening.records) || typeof opening.hasMore !== 'boolean') {
        return new Map(requests.map((request) => [request.key, { outcome: 'pending', unreadable: true, reason: 'session/follow 未返回有效开场帧。' }]));
      }
    } catch (error) {
      return new Map(requests.map((request) => [request.key, { outcome: 'pending', unreadable: true, reason: `session/follow 失败：${errorMessage(error)}` }]));
    }

    const events = opening.records.map((record) => record?.event).filter(Boolean);
    // 翻页只要覆盖最早一个请求的起点即可：rpcId 消息与其 turn/end 都不早于对应 prompt 时间。
    const untilTime = requests.reduce((min, request) => {
      const value = Number.isFinite(request.startedAt) && request.startedAt > 0 ? request.startedAt : Infinity;
      return Math.min(min, value);
    }, Infinity);
    const floorTime = Number.isFinite(untilTime) ? untilTime : 0;
    let beforeSeq;
    let reachedStart = !opening.hasMore;
    for (let page = 0; page < 100 && !reachedStart; page += 1) {
      let history;
      try {
        history = await this.invoke('page', {
          address,
          throughSeq: opening.cursor,
          maxMessages: 100,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
        });
      } catch (error) {
        return new Map(requests.map((request) => [request.key, { outcome: 'pending', unreadable: true, reason: `session/page 失败：${errorMessage(error)}` }]));
      }
      const records = Array.isArray(history?.records) ? history.records : [];
      const entries = records.map((record) => record?.event).filter(Boolean);
      events.push(...entries);
      const oldestTime = entries.reduce((min, event) => Math.min(min, event.time ?? Infinity), Infinity);
      const oldestSeq = entries.reduce((min, event) => Math.min(min, event.seq ?? Infinity), Infinity);
      if (!history?.hasMore || (floorTime > 0 && oldestTime <= floorTime)) {
        reachedStart = true;
        break;
      }
      if (!Number.isFinite(oldestSeq) || oldestSeq === beforeSeq) {
        return new Map(requests.map((request) => [request.key, { outcome: 'pending', unreadable: true, reason: 'session/page 历史分页没有前进。' }]));
      }
      beforeSeq = oldestSeq;
    }
    if (!reachedStart) {
      return new Map(requests.map((request) => [request.key, { outcome: 'pending', unreadable: true, reason: '会话历史在 100 页内未到达本次执行起点。' }]));
    }

    return inspectRequestsFromEvents(events, requests);
  }

  /** 单请求结算的兼容包装：旧调用（新会话派发）不带 requestId，按 startedAt 定位。 */
  async inspectSession(sessionId, startedAt = 0, summary, options = {}) {
    const results = await this.inspectRequests(sessionId, summary, [{
      key: 'single',
      ...(options.requestId ? { requestId: options.requestId } : {}),
      startedAt,
      originUrl: options.originUrl ?? '',
    }]);
    return results.get('single');
  }

  async dispose() {
    await this.peer.dispose();
  }
}
