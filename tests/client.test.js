import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function loadClientBridge(fetchImpl) {
  const source = (await readFile(new URL('../client.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const marker = '    function formatTime(value, fallback) {';
  assert.ok(source.includes(marker), 'client bridge test marker must remain present');
  // 只暴露文件内已有的 bridge/post，不改被测实现；factory 仍在原 ModuleLoader 中执行。
  const instrumented = source.replace(marker,
    `    globalThis.__clientBridgeForTest = { bridge, post };\n${marker}`);
  let definition;
  const context = vm.createContext({
    AbortSignal,
    fetch: fetchImpl,
    window: {
      __ModuleLoader__: {
        load(value) { definition = value; },
      },
    },
  });
  vm.runInContext(instrumented, context, { filename: 'client.js' });
  assert.ok(definition, 'client module must register itself');
  definition.factory((name) => {
    assert.equal(name, 'react');
    return { createElement() {}, Component: class {} };
  });
  return context.__clientBridgeForTest;
}

test('issue refresh and log clearing use POST while cached issue reads stay GET', async () => {
  const calls = [];
  const { bridge, post } = await loadClientBridge(async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      async json() { return { ok: true, items: [], orphans: [] }; },
    };
  });

  await post('issues', { refresh: true });
  await bridge('issues');
  await post('logs', { clear: true });

  assert.deepEqual(calls.map((call) => call.options.method), ['POST', 'GET', 'POST']);
  assert.deepEqual(JSON.parse(calls[0].options.body), { action: 'issues', refresh: true });
  assert.deepEqual(JSON.parse(calls[2].options.body), { action: 'logs', clear: true });
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[1].url, '/api/gitlab-todo-agent?action=issues');
  assert.equal(calls[1].options.body, undefined);
});
