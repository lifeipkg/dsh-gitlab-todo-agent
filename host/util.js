/**
 * 模块层共享的小工具：错误消息规整、JSON 响应、面板标题投影、运行时方法挂载。
 */

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 有界并发顺序保持的 map：用于轮询阶段并行跑预检判定。 */
export async function mapLimit(items, limit, worker) {
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

export function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** session/list 的人类可读标题在投影里，不在 item 顶层。 */
export function sessionSummaryTitle(summary) {
  const title = summary?.projections?.values?.title;
  return typeof title === 'string' ? title.trim() : '';
}

/**
 * 把 host/*.js 模块的方法集挂到运行时原型上。
 * 模块方法仍用 this.* 互调（与拆分前同一个实例），这里只做注册；
 * 启动时检查重复命名——同方法名在两处定义会静默互相覆盖，必须在加载期炸出来。
 */
export function attachRuntimeMethods(klass, modules) {
  const seen = new Set();
  for (const methods of modules) {
    for (const name of Object.keys(methods)) {
      if (seen.has(name) || name in klass.prototype) {
        throw new Error(`运行时方法重复定义：${name}`);
      }
      seen.add(name);
    }
    Object.assign(klass.prototype, methods);
  }
}
