import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildJudgePrompt,
  buildSessionTitle,
  buildTodoPrompt,
  parseJudgeReply,
  classifyTodo,
  defaultSettings,
  initialState,
  isDirectNoteMention,
  normalizeState,
  normalizeTodos,
  publicState,
  selectPendingTodos,
  validateSettings,
} from '../core.js';
import { GitlabTodoRuntime } from '../index.js';

const gitlabTodo = {
  id: 12345,
  body: 'fallback body',
  state: 'pending',
  action_name: 'assigned',
  author: { id: 1, username: 'root' },
  target_type: 'MergeRequest',
  target_url: 'https://gitlab.local/group/project/-/merge_requests/7',
  target: { title: 'Fix the parser', web_url: 'https://gitlab.local/group/project/-/merge_requests/7' },
  project: { path_with_namespace: 'group/project' },
};
const sessionTodo = {
  ...gitlabTodo,
  target_type: 'Issue',
  target_url: 'https://gitlab.local/group/project/-/issues/7',
  target: { ...gitlabTodo.target, web_url: 'https://gitlab.local/group/project/-/issues/7' },
};
const directNoteTodo = {
  ...sessionTodo,
  id: 'direct',
  action_name: 'directly_addressed',
  author: { id: 52, username: 'other-user' },
  target_url: 'https://gitlab.local/group/project/-/issues/7#note_10',
};

test('normalizes empty and populated GitLab todo arrays', () => {
  assert.deepEqual(normalizeTodos([]), []);
  const [todo] = normalizeTodos([gitlabTodo]);
  assert.equal(todo.id, '12345');
  assert.equal(todo.title, 'Fix the parser');
  assert.equal(todo.url, gitlabTodo.target_url);
  assert.equal(todo.project, 'group/project');
  assert.equal(todo.targetType, 'MergeRequest');
  assert.equal(todo.action, 'assigned');
  assert.equal(todo.authorId, '1');
  assert.equal(todo.author, 'root');
  assert.equal(todo.noteId, '');
});

test('rejects malformed, duplicate or unsafe todo data', () => {
  assert.throws(() => normalizeTodos({ todos: [] }), /必须是数组/);
  assert.throws(() => normalizeTodos([{ title: 'missing' }]), /有效 id/);
  assert.throws(() => normalizeTodos([{ id: 'a' }, { id: 'a' }]), /重复 Todo id/);
  assert.equal(normalizeTodos([{ id: 'a', url: 'javascript:alert(1)' }])[0].url, '');
});

test('pending selection skips accepted ids and enforces the batch limit', () => {
  const todos = normalizeTodos([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  assert.deepEqual(selectPendingTodos(todos, { a: {} }, 1).map((item) => item.id), ['b']);
  assert.deepEqual(selectPendingTodos(todos, new Set(['a', 'b']), 5).map((item) => item.id), ['c']);
});

test('only direct note mentions from another user are actionable', () => {
  const [direct] = normalizeTodos([directNoteTodo]);
  assert.equal(direct.noteId, '10');
  assert.equal(isDirectNoteMention(direct, '106'), true);
  assert.equal(classifyTodo(direct, '106'), 'direct-mention');
  assert.equal(classifyTodo(direct, '52'), 'other');
  assert.equal(classifyTodo({ ...direct, url: 'https://gitlab.local/group/project/-/issues/7' }, '106'), 'other');
  assert.equal(classifyTodo({ ...direct, action: 'mentioned' }, '106'), 'other');
  assert.equal(classifyTodo({ ...direct, authorId: '' }, '106'), 'other');
});

test('direct MR note mentions create work instead of being classified as MR cleanup', () => {
  const [directMr] = normalizeTodos([{
    ...directNoteTodo,
    target_type: 'MergeRequest',
    target_url: 'https://gitlab.local/group/project/-/merge_requests/7#note_10',
  }]);
  assert.equal(classifyTodo(directMr, '106'), 'direct-mention');
  assert.equal(classifyTodo(normalizeTodos([gitlabTodo])[0], '106'), 'merge-request');
  assert.equal(classifyTodo({ targetType: '', url: 'https://gitlab.local/group/project/-/merge_requests/8', action: '' }, '106'), 'merge-request');
});

test('settings validation preserves supported fields and drops legacy script fields', () => {
  assert.equal(defaultSettings().maxConcurrentSessions, 2);
  const current = { ...defaultSettings(), script: 'legacy', shell: 'powershell' };
  const next = validateSettings({ enabled: true, intervalSeconds: 60, maxSessionsPerPoll: 3, maxConcurrentSessions: 4 }, current);
  assert.equal(next.enabled, true);
  assert.equal(next.intervalSeconds, 60);
  assert.equal(next.maxSessionsPerPoll, 3);
  assert.equal(next.maxConcurrentSessions, 4);
  assert.equal('script' in next, true);
  assert.equal('shell' in next, true);
  const clean = validateSettings({ script: 'ignored', shell: 'ignored' }, defaultSettings());
  assert.equal('script' in clean, false);
  assert.equal('shell' in clean, false);
  const configured = validateSettings({
    sessionCwd: ' D:\\work\\repo ',
    sessionModel: { provider: ' deepseek ', model: ' deepseek-chat ' },
  }, defaultSettings());
  assert.equal(configured.sessionCwd, 'D:\\work\\repo');
  assert.deepEqual(configured.sessionModel, { provider: 'deepseek', model: 'deepseek-chat' });
  assert.equal(validateSettings({ sessionModel: null }, configured).sessionModel, null);
  assert.throws(() => validateSettings({ sessionModel: { provider: 'deepseek' } }, defaultSettings()), /Session 模型/);
  assert.throws(() => validateSettings({ sessionCwd: 42 }, defaultSettings()), /Session 工作区文件夹/);
  assert.throws(() => validateSettings({ cwd: 42 }, defaultSettings()), /GitLab 工作目录/);
  assert.throws(() => validateSettings({ intervalSeconds: 1 }, defaultSettings()), /轮询间隔/);
  assert.throws(() => validateSettings({ maxConcurrentSessions: 0 }, defaultSettings()), /并发数/);
  assert.throws(() => validateSettings({ maxConcurrentSessions: 11 }, defaultSettings()), /并发数/);
});

test('prompt identifies the todo as data and defers mark-as-done until completion', () => {
  const prompt = buildTodoPrompt(normalizeTodos([directNoteTodo])[0]);
  assert.match(prompt, /todos\/direct\/mark_as_done/);
  assert.match(prompt, /glab api -X POST todos\/direct\/mark_as_done/);
  assert.match(prompt, /原 note（ID: 10）/);
  assert.match(prompt, /@other-user/);
  assert.match(prompt, /不要只新建顶层评论/);
  assert.match(prompt, /--reply <discussion-id>/);
  assert.match(prompt, /discussions\/<discussion-id>\/notes/);
  assert.match(prompt, /不可信/);
  assert.match(prompt, /只有实际完成/);
  assert.match(prompt, /#note_10/);
  assert.match(prompt, /other-user/);
});

test('session titles identify the target type, id and note', () => {
  const title = (url, extra = {}) => buildSessionTitle(normalizeTodos([{ ...sessionTodo, ...extra, target_url: url }])[0]);
  assert.equal(title('https://gitlab.local/g/p/-/issues/7#note_10'), '[协助]-issue-7-note-10');
  assert.equal(title('https://gitlab.local/g/p/-/issues/7'), '[协助]-issue-7');
  assert.equal(title('https://gitlab.local/g/p/-/work_items/186#note_136301'), '[协助]-workitem-186-note-136301');
  assert.equal(title('https://gitlab.local/g/p/-/merge_requests/1002#note_132985'), '[协助]-mr-1002-note-132985');
  assert.equal(title('https://gitlab.local/g/p/-/epics/12'), '[协助]-epic-12');
  // 非标准路径：退回 URL 最后两段。
  assert.equal(title('https://gitlab.local/g/p/snippets/99'), '[协助]-snippets-99');
  // 无 URL：退回 todo id。
  assert.equal(title('', { target: {} }), `[协助]-todo-${sessionTodo.id}`);
});

test('session projection lists dispatched sessions with status', () => {
  const base = initialState();
  base.handled.a = {
    id: 'a', sessionId: 'session-a', acceptedAt: 20, sessionTitle: '[协助]-issue-1-note-2',
    executionStatus: 'completed', automatic: true, title: 'A', url: 'https://gitlab.local/a', project: 'g/p',
  };
  base.handled.b = { id: 'b', sessionId: 'session-b', acceptedAt: 30, executionStatus: 'running', automatic: false, title: 'B', url: '', project: '' };
  base.handled.mr = { id: 'mr', sessionId: null, outcome: 'merge-request-done', acceptedAt: 40, title: 'MR', url: '', project: '' };
  base.pending.c = { sessionId: 'session-c', createdAt: 25, automatic: true, item: normalizeTodos([{ ...sessionTodo, id: 'c' }])[0] };
  const view = publicState(base, false, '106');
  assert.deepEqual(view.sessions.map((record) => [record.sessionId, record.executionStatus]), [
    ['session-b', 'running'],
    ['session-c', 'starting'],
    ['session-a', 'completed'],
  ]);
  assert.equal(view.sessions[2].sessionTitle, '[协助]-issue-1-note-2');
  assert.equal(view.sessions.some((record) => record.sessionId === null), false);
});

test('judge prompt and reply parsing are conservative', () => {
  const prompt = buildJudgePrompt(normalizeTodos([directNoteTodo])[0]);
  assert.match(prompt, /预检器/);
  assert.match(prompt, /needsProcessing/);
  assert.match(prompt, /不可信|待判定数据/);
  assert.deepEqual(parseJudgeReply('{"needsProcessing":false,"reason":"纯感谢"}'), { needsProcessing: false, reason: '纯感谢' });
  assert.deepEqual(parseJudgeReply('说明 {"needsProcessing":true} 尾巴'), { needsProcessing: true, reason: '' });
  assert.equal(parseJudgeReply('不是 JSON'), null);
  assert.equal(parseJudgeReply('{"foo":1}'), null);
});

function runtimeWithLlmJudge(reply) {
  const harness = runtimeWithPrompt(async () => ({ accepted: true }));
  harness.runtime.ctx.llm = {
    async prepareCall(route) {
      return {
        config: route,
        stream: async function* stream() {
          yield { text: reply };
        },
      };
    },
    stream() {
      throw new Error('should go through prepareCall');
    },
  };
  return harness;
}

test('precheck marks a todo done without a session when the judge declines', async () => {
  const { runtime, calls } = runtimeWithLlmJudge('{"needsProcessing":false,"reason":"纯感谢，无需处理"}');
  let marked = 0;
  runtime.markTodoDone = async () => { marked += 1; };
  runtime.state.settings.enabled = true;
  runtime.state.settings.autoProcess = true;
  runtime.fetchTodos = async () => normalizeTodos([directNoteTodo]);
  await runtime.executePoll('test');
  await runtime.pump();
  assert.equal(calls.create, 0);
  assert.equal(calls.prompt, 0);
  assert.equal(marked, 1);
  assert.equal(runtime.state.handled.direct.outcome, 'precheck-skipped');
  assert.equal(runtime.state.handled.direct.skipReason, '纯感谢，无需处理');
  assert.equal(runtime.occupiedSlots(), 0);
});

test('precheck opens the session when the judge requires handling or is unavailable', async () => {
  const required = runtimeWithLlmJudge('{"needsProcessing":true,"reason":"有具体问题"}');
  required.runtime.state.settings.enabled = true;
  required.runtime.state.settings.autoProcess = true;
  required.runtime.fetchTodos = async () => normalizeTodos([directNoteTodo]);
  await required.runtime.executePoll('test');
  await required.runtime.pump();
  assert.equal(required.calls.create, 1);
  assert.equal(required.runtime.state.handled.direct.outcome, 'session-accepted');

  const broken = runtimeWithLlmJudge('模型输出的不是 JSON');
  broken.runtime.state.settings.enabled = true;
  broken.runtime.state.settings.autoProcess = true;
  broken.runtime.fetchTodos = async () => normalizeTodos([directNoteTodo]);
  await broken.runtime.executePoll('test');
  await broken.runtime.pump();
  assert.equal(broken.calls.create, 1);

  const noLlm = runtimeWithPrompt(async () => ({ accepted: true }));
  noLlm.runtime.state.settings.enabled = true;
  noLlm.runtime.state.settings.autoProcess = true;
  noLlm.runtime.fetchTodos = async () => normalizeTodos([directNoteTodo]);
  await noLlm.runtime.executePoll('test');
  await noLlm.runtime.pump();
  assert.equal(noLlm.calls.create, 1);
  await Promise.all([required.runtime.stop(), broken.runtime.stop(), noLlm.runtime.stop()]);
});

test('manual dispatch never runs the precheck', async () => {
  const { runtime, calls } = runtimeWithLlmJudge('{"needsProcessing":false,"reason":"纯感谢"}');
  let judged = 0;
  runtime.judgeNeedsProcessing = async () => { judged += 1; return { needsProcessing: false, reason: '' }; };
  const [todo] = normalizeTodos([directNoteTodo]);
  const result = await runtime.dispatch(todo);
  assert.equal(result.ok, true);
  assert.equal(judged, 0);
  assert.equal(calls.create, 1);
  await runtime.stop();
});

test('state normalization and public projection retain accepted session links', () => {
  const base = initialState();
  base.handled.a = { id: 'a', sessionId: 'session-a', acceptedAt: 10, title: 'A', url: '', project: '' };
  base.todos = normalizeTodos([directNoteTodo]);
  const state = normalizeState(JSON.parse(JSON.stringify(base)));
  const view = publicState(state, false, '106');
  assert.equal(view.handledCount, 1);
  assert.equal(view.recent[0].sessionId, 'session-a');
  assert.equal(view.settings.enabled, false);
  assert.equal(view.todos[0].directMention, true);
});

test('state normalization migrates the legacy shared cwd to new sessions', () => {
  const base = initialState();
  base.settings.cwd = 'D:\\legacy\\workspace';
  delete base.settings.sessionCwd;
  const state = normalizeState(JSON.parse(JSON.stringify(base)));
  assert.equal(state.settings.cwd, 'D:\\legacy\\workspace');
  assert.equal(state.settings.sessionCwd, 'D:\\legacy\\workspace');
  assert.equal(state.settings.sessionModel, null);
});

test('state normalization migrates v1 and v2 script states to v3', () => {
  for (const version of [1, 2]) {
    const legacy = {
      version,
      settings: {
        enabled: true,
        shell: 'powershell',
        script: 'legacy script',
        intervalSeconds: 300,
        maxSessionsPerPoll: 2,
        cwd: '',
        sessionCwd: 'D:\\work\\repo',
        sessionModel: null,
      },
      todos: [{ id: 'x', title: 'Legacy todo' }],
      handled: {},
      pending: {},
      recent: [],
      lastNewCount: 0,
    };
    const state = normalizeState(legacy);
    assert.equal(state.version, 3);
    assert.equal('shell' in state.settings, false);
    assert.equal('script' in state.settings, false);
    assert.equal(state.settings.enabled, true);
    assert.equal(state.settings.sessionCwd, 'D:\\work\\repo');
    assert.equal(state.todos[0].id, 'x');
  }
  assert.throws(() => normalizeState({ version: 99 }), /版本不受支持/);
});

function runtimeWithPrompt(prompt, options = {}) {
  const sessions = new Map();
  const calls = {
    create: 0,
    prompt: 0,
    createRequests: [],
    modelSelections: [],
    renames: [],
    invocations: [],
    archives: [],
    failArchive: false,
    sessions,
    failList: false,
  };
  const autoComplete = options.autoComplete !== false;
  const complete = (sessionId, kind = 'completed') => {
    const session = sessions.get(sessionId);
    if (!session) return;
    session.running = false;
    session.events.push({
      type: 'turn/end',
      seq: session.events.length + 1,
      time: Date.now(),
      data: { reason: { kind } },
    });
  };
  calls.complete = complete;
  const catalog = {
    default: { provider: 'deepseek', model: 'deepseek-chat' },
    routableProviders: ['deepseek'],
    groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }],
    failures: [],
  };
  const gateway = {
    async invoke(call) {
      calls.invocations.push(call);
      assert.equal(call.peer.principal.kind, 'owner');
      if (call.namespace === 'workspace') {
        assert.equal(call.method, 'archiveSession');
        assert.deepEqual(call.args, { request: { sessionId: call.args.request.sessionId } });
        if (calls.failArchive) throw new Error('workspace/session-active');
        calls.archives.push(call.args.request.sessionId);
        return { archivedSessionIds: [call.args.request.sessionId] };
      }
      assert.equal(call.namespace, 'session');
      const { method, args } = call;
      if (method === 'modelCatalog') {
        assert.deepEqual(args, {});
        return catalog;
      }
      if (method === 'list') {
        assert.deepEqual(args, { _request: {} });
        if (calls.failList) throw new Error('roster unavailable');
        return {
          items: [...sessions.entries()].map(([sessionId, session]) => ({ sessionId, running: session.running })),
        };
      }
      const request = args.request;
      if (method === 'create') {
        calls.create += 1;
        calls.createRequests.push(request);
        const sessionId = `session-${calls.create}`;
        sessions.set(sessionId, { running: false, events: [] });
        return { sessionId };
      }
      if (method === 'rename') {
        calls.renames.push(request);
        return {};
      }
      if (method === 'selectModel') {
        calls.modelSelections.push(request);
        return { selected: request };
      }
      if (method === 'prompt') {
        calls.prompt += 1;
        const session = sessions.get(request.sessionId);
        session.running = true;
        try {
          const result = await prompt(request, call.signal);
          if (autoComplete) complete(request.sessionId);
          return result;
        } catch (error) {
          session.running = false;
          throw error;
        }
      }
      if (method === 'page') {
        const session = sessions.get(request.address.sessionId);
        return {
          records: (session?.events ?? []).map((event) => ({ type: 'event', event })),
          hasMore: false,
        };
      }
      throw new Error(`unexpected session method: ${method}`);
    },
    async stream(call) {
      assert.equal(call.peer.principal.kind, 'owner');
      assert.equal(call.method, 'follow');
      const session = sessions.get(call.args.request.address.sessionId);
      const events = session?.events ?? [];
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'snapshot',
            cursor: events.at(-1)?.seq ?? 0,
            records: events.map((event) => ({ type: 'event', event })),
            hasMore: false,
          };
        },
      };
    },
  };
  const ctx = {
    typertGateway: gateway,
    workspaceRegistry: {
      list: () => [
        { id: 'workspace-default', path: 'D:\\agent-workspace', updatedAt: '2026-01-01T00:00:00Z' },
        { id: 'workspace-work', path: 'D:\\work\\repo', updatedAt: '2026-01-02T00:00:00Z' },
      ],
    },
    logger: { warn() {} },
  };
  const runtime = new GitlabTodoRuntime(ctx);
  runtime.state = initialState();
  runtime.gitlabUserId = '106';
  runtime.persistQuietly = async () => {};
  return { runtime, calls };
}

test('dispatch creates and prompts once, then deduplicates accepted todos', async () => {
  const { runtime, calls } = runtimeWithPrompt(async (request) => {
    
    assert.equal(request.sessionId, 'session-1');
    assert.equal(request.mode, 'queue');
    assert.match(request.requestId, /^gitlab-todo-/);
    return { accepted: true };
  });
  const [todo] = normalizeTodos([sessionTodo]);
  const first = await runtime.dispatch(todo);
  const second = await runtime.dispatch(todo);
  assert.equal(first.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(calls.create, 1);
  assert.equal(calls.prompt, 1);
  assert.equal(runtime.state.handled[todo.id].sessionId, 'session-1');
});

test('dispatch resolves workspaceId and applies the fixed model before prompting', async () => {
  const { runtime, calls } = runtimeWithPrompt(async () => ({ accepted: true }));
  runtime.state.settings.sessionCwd = 'D:\\work\\repo';
  runtime.state.settings.sessionModel = { provider: 'deepseek', model: 'deepseek-chat' };
  const [todo] = normalizeTodos([sessionTodo]);
  const result = await runtime.dispatch(todo);
  assert.equal(result.ok, true);
  assert.deepEqual(calls.createRequests, [{ workspaceId: 'workspace-work' }]);
  assert.deepEqual(calls.modelSelections, [{ sessionId: 'session-1', provider: 'deepseek', model: 'deepseek-chat' }]);
  assert.deepEqual(calls.renames, [{ sessionId: 'session-1', title: '[协助]-issue-7' }]);
  const methods = calls.invocations.map((call) => call.method);
  assert.ok(methods.indexOf('create') < methods.indexOf('selectModel'));
  assert.ok(methods.indexOf('selectModel') < methods.indexOf('prompt'));
});

test('a failed prompt reuses its pending session on the next dispatch', async () => {
  const { runtime, calls } = runtimeWithPrompt(async () => {
    
    if (calls.prompt === 1) throw new Error('temporary failure');
    return { accepted: true };
  });
  const [todo] = normalizeTodos([sessionTodo]);
  runtime.state.todos = [todo];
  const failed = await runtime.dispatchById(todo.id);
  const retried = await runtime.dispatchById(todo.id);
  assert.equal(failed.ok, false);
  assert.equal(retried.ok, true);
  assert.equal(calls.create, 1);
  assert.equal(calls.prompt, 2);
  assert.equal(retried.sessionId, 'session-1');
  assert.equal(runtime.state.pending[todo.id], undefined);
});

test('non-mention MR dispatch marks GitLab done without a Session and survives reload', async () => {
  const { runtime, calls } = runtimeWithPrompt(async () => {
    
    return { accepted: true };
  });
  let marked = 0;
  runtime.markTodoDone = async () => { marked += 1; };
  const [todo] = normalizeTodos([gitlabTodo]);
  runtime.state.todos = [todo];
  const result = await runtime.dispatchById(todo.id);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(marked, 1);
  assert.equal(calls.create, 0);
  assert.equal(calls.prompt, 0);
  assert.equal(runtime.state.handled[todo.id].outcome, 'merge-request-done');
  const restored = normalizeState(JSON.parse(JSON.stringify(runtime.state)));
  assert.equal(restored.handled[todo.id].outcome, 'merge-request-done');
  assert.equal(publicState(restored, false, '106').todos[0].outcome, 'merge-request-done');
});

test('direct MR note mention dispatch creates a Session instead of marking done', async () => {
  const { runtime, calls } = runtimeWithPrompt(async () => {
    
    return { accepted: true };
  });
  let marked = 0;
  runtime.markTodoDone = async () => { marked += 1; };
  const [todo] = normalizeTodos([{
    ...directNoteTodo,
    id: 'direct-mr',
    target_type: 'MergeRequest',
    target_url: 'https://gitlab.local/group/project/-/merge_requests/7#note_10',
  }]);
  const result = await runtime.dispatch(todo);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, undefined);
  assert.equal(marked, 0);
  assert.equal(calls.create, 1);
  assert.equal(calls.prompt, 1);
  assert.equal(runtime.state.handled[todo.id].outcome, 'session-accepted');
});

test('automatic poll only dispatches direct note mentions from other users', async () => {
  const { runtime, calls } = runtimeWithPrompt(async () => {
    
    return { accepted: true };
  });
  let marked = 0;
  runtime.markTodoDone = async () => { marked += 1; };
  runtime.state.settings.enabled = true;
  runtime.state.settings.autoProcess = true;
  const directMr = {
    ...directNoteTodo,
    id: 'direct-mr',
    target_type: 'MergeRequest',
    target_url: 'https://gitlab.local/group/project/-/merge_requests/7#note_11',
  };
  const selfMention = { ...directNoteTodo, id: 'self', author: { id: 106, username: 'me' } };
  const descriptionMention = { ...directNoteTodo, id: 'description', target_url: sessionTodo.target_url };
  const ordinaryMention = { ...directNoteTodo, id: 'mentioned', action_name: 'mentioned' };
  runtime.fetchTodos = async () => normalizeTodos([gitlabTodo, directNoteTodo, directMr, selfMention, descriptionMention, ordinaryMention]);
  await runtime.executePoll('test');
  await runtime.pump();
  assert.equal(marked, 0);
  assert.equal(calls.create, 2);
  assert.equal(calls.prompt, 2);
  assert.equal(runtime.state.handled.direct.outcome, 'session-accepted');
  assert.equal(runtime.state.handled['direct-mr'].outcome, 'session-accepted');
  for (const id of ['12345', 'self', 'description', 'mentioned']) {
    assert.equal(runtime.state.handled[id], undefined);
  }
});

test('auto dispatch holds concurrency slots until sessions actually settle', async () => {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (predicate) => {
    for (let i = 0; i < 400 && !predicate(); i += 1) await delay(5);
  };
  const { runtime, calls } = runtimeWithPrompt(async () => ({ accepted: true }), { autoComplete: false });
  runtime.config.slotWaitMs = 20;
  runtime.config.sessionPollMs = 20;
  runtime.state.settings.enabled = true;
  runtime.state.settings.autoProcess = true;
  runtime.state.settings.maxSessionsPerPoll = 4;
  runtime.state.settings.maxConcurrentSessions = 2;
  const directTodos = Array.from({ length: 4 }, (_, index) => ({
    ...directNoteTodo,
    id: `slot-${index}`,
    target_url: `https://gitlab.local/group/project/-/issues/7#note_${200 + index}`,
  }));
  runtime.fetchTodos = async () => normalizeTodos(directTodos);
  await runtime.executePoll('test');
  await waitFor(() => calls.create >= 2);
  assert.equal(calls.create, 2);
  assert.equal(runtime.occupiedSlots(), 2);

  // 第 1 个会话回合完成并结算后，槽位释放，队列启动第 3 个。
  calls.complete('session-1');
  await waitFor(() => calls.create >= 3);
  assert.equal(calls.create, 3);
  assert.equal(runtime.occupiedSlots(), 2);

  calls.complete('session-2');
  calls.complete('session-3');
  await waitFor(() => calls.create >= 4);
  assert.equal(calls.create, 4);

  calls.complete('session-4');
  await waitFor(() => runtime.occupiedSlots() === 0);
  await runtime.pump();
  assert.equal(runtime.dispatchQueue.length, 0);
  await runtime.stop();
});

test('reconcile settles executions by turn/end verdict and never misreads roster failures', async () => {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (predicate) => {
    for (let i = 0; i < 400 && !predicate(); i += 1) await delay(5);
  };
  const { runtime, calls } = runtimeWithPrompt(async () => ({ accepted: true }), { autoComplete: false });
  runtime.config.sessionPollMs = 20;
  runtime.state.settings.enabled = true;
  runtime.state.settings.autoProcess = true;
  runtime.fetchTodos = async () => normalizeTodos([directNoteTodo]);
  await runtime.executePoll('test');
  await runtime.pump();
  assert.equal(runtime.state.handled.direct.executionStatus, 'running');

  // 名册读取失败不是空闲：结算保持 running，不释放槽位。
  calls.failList = true;
  await runtime.reconcileSessions();
  assert.equal(runtime.state.handled.direct.executionStatus, 'running');
  assert.equal(runtime.occupiedSlots(), 1);

  // 回合完成：结算 completed、自动归档并释放槽位。
  calls.failList = false;
  calls.complete('session-1');
  await runtime.reconcileSessions();
  assert.equal(runtime.state.handled.direct.executionStatus, 'completed');
  assert.deepEqual(calls.archives, ['session-1']);
  assert.equal(runtime.state.handled.direct.archived, true);
  assert.equal(runtime.occupiedSlots(), 0);

  // 回合失败：结算 failed，不归档。
  const [retry] = normalizeTodos([{ ...directNoteTodo, id: 'failing', target_url: 'https://gitlab.local/group/project/-/issues/7#note_77' }]);
  await runtime.dispatch(retry, true);
  calls.complete('session-2', 'error');
  await runtime.reconcileSessions();
  assert.equal(runtime.state.handled.failing.executionStatus, 'failed');
  assert.equal(runtime.state.handled.failing.archived, false);
  assert.deepEqual(calls.archives, ['session-1']);

  // 会话从名册消失：结算 failed 而不是永久占槽。
  const [vanishing] = normalizeTodos([{ ...directNoteTodo, id: 'vanishing', target_url: 'https://gitlab.local/group/project/-/issues/7#note_78' }]);
  await runtime.dispatch(vanishing, true);
  calls.sessions.delete('session-3');
  await runtime.reconcileSessions();
  assert.equal(runtime.state.handled.vanishing.executionStatus, 'failed');
  assert.equal(runtime.occupiedSlots(), 0);
  await runtime.stop();
});

test('archive refusal and the switch never affect settlement', async () => {
  const refused = runtimeWithPrompt(async () => ({ accepted: true }), { autoComplete: false });
  refused.calls.failArchive = true;
  refused.runtime.state.settings.enabled = true;
  refused.runtime.state.settings.autoProcess = true;
  refused.runtime.fetchTodos = async () => normalizeTodos([directNoteTodo]);
  await refused.runtime.executePoll('test');
  await refused.runtime.pump();
  refused.calls.complete('session-1');
  await refused.runtime.reconcileSessions();
  assert.equal(refused.runtime.state.handled.direct.executionStatus, 'completed');
  assert.equal(refused.runtime.state.handled.direct.archived, false);
  assert.match(refused.runtime.state.handled.direct.archiveError, /session-active/);
  assert.equal(refused.runtime.occupiedSlots(), 0);
  await refused.runtime.stop();

  const off = runtimeWithPrompt(async () => ({ accepted: true }), { autoComplete: false });
  off.runtime.state.settings.enabled = true;
  off.runtime.state.settings.autoProcess = true;
  off.runtime.state.settings.autoArchive = false;
  off.runtime.fetchTodos = async () => normalizeTodos([directNoteTodo]);
  await off.runtime.executePoll('test');
  await off.runtime.pump();
  off.calls.complete('session-1');
  await off.runtime.reconcileSessions();
  assert.equal(off.runtime.state.handled.direct.executionStatus, 'completed');
  assert.deepEqual(off.calls.archives, []);
  assert.equal(off.runtime.state.handled.direct.archived, false);
  await off.runtime.stop();
});

test('manual refresh does not dispatch while automatic processing is disabled', async () => {
  const { runtime, calls } = runtimeWithPrompt(async () => ({ accepted: true }));
  runtime.fetchTodos = async () => normalizeTodos([directNoteTodo]);
  await runtime.executePoll('manual');
  assert.equal(calls.create, 0);
  assert.equal(calls.prompt, 0);
  assert.equal(runtime.state.handled.direct, undefined);
});

test('built-in fetch reads the current user once and paginates todos', async () => {
  const { runtime } = runtimeWithPrompt(async () => ({ accepted: true }));
  runtime.gitlabUserId = null;
  const requests = [];
  runtime.runGlab = async (args) => {
    requests.push(args);
    if (args[1] === 'user') return JSON.stringify({ id: 106, username: 'me' });
    const page = Number(args.at(-1).split('=')[1]);
    if (page === 1) {
      return JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ ...sessionTodo, id: `page-1-${index}` })));
    }
    if (page === 2) return JSON.stringify([{ ...sessionTodo, id: 'page-2-0' }]);
    throw new Error(`unexpected page ${page}`);
  };
  const todos = await runtime.fetchTodos();
  await runtime.currentGitlabUserId();
  assert.equal(todos.length, 101);
  assert.equal(requests.filter((args) => args[1] === 'user').length, 1);
  assert.equal(requests.filter((args) => args.includes('todos')).length, 2);
  assert.equal(requests[1].at(-1), 'page=1');
  assert.equal(requests[2].at(-1), 'page=2');
});

test('fetch handler returns state and validates settings updates', async () => {
  const { runtime } = runtimeWithPrompt(async () => ({ accepted: true }));
  const stateResponse = await runtime.handleFetch(new Request('http://127.0.0.1/api/gitlab-todo-agent?action=state'));
  assert.equal(stateResponse.status, 200);
  const stateBody = await stateResponse.json();
  assert.equal(stateBody.ok, true);
  assert.equal(stateBody.state.settings.enabled, false);
  assert.equal('scriptPath' in stateBody.state.storage, false);

  const modelsResponse = await runtime.handleFetch(new Request('http://127.0.0.1/api/gitlab-todo-agent?action=models'));
  const modelsBody = await modelsResponse.json();
  assert.equal(modelsResponse.status, 200);
  assert.equal(modelsBody.catalog.groups[0].models[0].id, 'deepseek-chat');

  const modelsPostResponse = await runtime.handleFetch(new Request('http://127.0.0.1/api/gitlab-todo-agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'models' }),
  }));
  assert.equal(modelsPostResponse.status, 200);
  assert.equal((await modelsPostResponse.json()).catalog.groups[0].models[0].id, 'deepseek-chat');

  const updateResponse = await runtime.handleFetch(new Request('http://127.0.0.1/api/gitlab-todo-agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'updateSettings', settings: { intervalSeconds: 60 } }),
  }));
  const updateBody = await updateResponse.json();
  assert.equal(updateBody.state.settings.intervalSeconds, 60);

  const badResponse = await runtime.handleFetch(new Request('http://127.0.0.1/api/gitlab-todo-agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'updateSettings', settings: { intervalSeconds: 1 } }),
  }));
  assert.equal(badResponse.status, 400);
});

test('startup upgrades script-era state without creating script files', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.test-storage-'));
  const unregister = async () => {};
  const legacy = initialState();
  legacy.version = 2;
  legacy.settings.script = 'legacy script';
  legacy.settings.shell = 'powershell';
  legacy.todos = normalizeTodos([directNoteTodo]);
  await writeFile(join(directory, 'state.json'), JSON.stringify(legacy), 'utf8');
  const runtime = new GitlabTodoRuntime({
    connection: { fetch: { register: () => unregister } },
    logger: { warn() {} },
  }, {
    storageDirectory: directory,
    legacyStateFile: join(directory, 'no-legacy.json'),
  });
  try {
    await runtime.start();
    const state = runtime.snapshot();
    assert.equal(state.storage.directory, directory);
    assert.equal('scriptPath' in state.storage, false);
    assert.equal(state.todos[0].id, 'direct');
    const stored = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
    assert.equal(stored.version, 3);
    assert.equal('script' in stored.settings, false);
    assert.equal('shell' in stored.settings, false);
    await assert.rejects(readFile(join(directory, 'gitlab-todos.py'), 'utf8'), /ENOENT/);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
