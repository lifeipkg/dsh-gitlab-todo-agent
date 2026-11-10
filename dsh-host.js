import { randomUUID } from 'node:crypto';

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

  listSessions() {
    return this.invoke('list', {});
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
   * 归档会话：workspace 命名空间，owner-only。
   * 不带 stopActivity——仍有工作在跑的会话会被 Host 以 workspace/session-active 拒绝，
   * 调用方据此把失败记录下来而不是强行停止任何工作。
   */
  archiveSession(sessionId) {
    if (!this.gateway || typeof this.gateway.invoke !== 'function') {
      throw new Error('当前 Host 不提供 typertGateway.invoke，无法归档会话。');
    }
    return this.gateway.invoke({
      namespace: 'workspace',
      method: 'archiveSession',
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
   */
  async inspectSession(sessionId, startedAt = 0, summary) {
    if (summary?.running) return { outcome: 'pending' };
    if (!summary) return { outcome: 'cancelled', error: '执行会话已不存在。' };

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
        return { outcome: 'pending', unreadable: true, reason: 'session/follow 未返回有效开场帧。' };
      }
    } catch (error) {
      return { outcome: 'pending', unreadable: true, reason: `session/follow 失败：${errorMessage(error)}` };
    }

    const events = opening.records.map((record) => record?.event).filter(Boolean);
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
        return { outcome: 'pending', unreadable: true, reason: `session/page 失败：${errorMessage(error)}` };
      }
      const records = Array.isArray(history?.records) ? history.records : [];
      const entries = records.map((record) => record?.event).filter(Boolean);
      events.push(...entries);
      const oldestTime = entries.reduce((min, event) => Math.min(min, event.time ?? Infinity), Infinity);
      const oldestSeq = entries.reduce((min, event) => Math.min(min, event.seq ?? Infinity), Infinity);
      if (!history?.hasMore || (startedAt > 0 && oldestTime <= startedAt)) {
        reachedStart = true;
        break;
      }
      if (!Number.isFinite(oldestSeq) || oldestSeq === beforeSeq) {
        return { outcome: 'pending', unreadable: true, reason: 'session/page 历史分页没有前进。' };
      }
      beforeSeq = oldestSeq;
    }
    if (!reachedStart) {
      return { outcome: 'pending', unreadable: true, reason: '会话历史在 100 页内未到达本次执行起点。' };
    }

    const turnEnd = events
      .filter((event) => event?.type === 'turn/end' && (startedAt <= 0 || event.time >= startedAt))
      .sort((a, b) => a.seq - b.seq)[0];
    if (!turnEnd) return { outcome: 'pending' };
    const failure = turnFailure(turnEnd.data);
    return failure === null
      ? { outcome: 'succeeded' }
      : { outcome: 'failed', error: `Agent 回合未成功完成：${failure}` };
  }

  async dispose() {
    await this.peer.dispose();
  }
}
