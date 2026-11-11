window.__ModuleLoader__.load({
  id: '@local/dsh-gitlab-todo-agent',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'gitlab-todo-agent';
    const PANEL_ID = 'gitlab-todos';
    const BRIDGE_PATH = '/api/gitlab-todo-agent';
    const en = {
      panel: 'GitLab Todo', title: 'GitLab Todo Watcher',
      subtitle: 'Read GitLab todos directly and open sessions for direct mentions in comments from other users.',
      enable: 'Enable polling', disable: 'Disable polling', checkNow: 'Check now', checking: 'Checking…',
      settings: 'Settings', save: 'Save settings', cancel: 'Cancel', close: 'Close',
      enabled: 'Enabled', disabled: 'Disabled', running: 'Running', idle: 'Idle',
      activeSessions: 'Auto sessions running', queuedSessions: 'Queued for dispatch',
      pending: 'Pending', handled: 'Handled', lastSuccess: 'Last successful poll', never: 'Never',
      mrDone: 'MR marked done without processing', markDone: 'Mark done',
      newFound: 'Unaccepted todos in the latest output',
      todoList: 'Todo list', noTodos: 'No todos. Run a check to refresh.',
      directMention: 'Comment @ me',
      sessionsTitle: 'Recent sessions', noSessions: 'No session has been dispatched yet.', autoDispatch: 'auto', manualDispatch: 'manual',
      loadMore: 'Load more', sessionsError: 'Could not load recent sessions',
      archiveSession: 'Archive', unarchiveSession: 'Unarchive',
      sessionStarting: 'Starting', sessionAccepted: 'Queued',
      process: 'Open session', reprocess: 'Process again', dispatched: 'Accepted', waiting: 'Waiting',
      executionRunning: 'Running', executionCompleted: 'Completed', executionFailed: 'Failed',
      precheckSkipped: 'Skipped (no handling needed)',
      ruleSkipped: 'Skipped (rule)',
      sessionArchived: 'Archived',
      openSession: 'Open session',
      interval: 'Poll interval (seconds)', limit: 'Maximum new sessions per poll', concurrency: 'Automatic dispatch concurrency',
      cwd: 'GitLab working directory', cwdHint: 'Leave empty to use the Host process directory.',
      sessionCwd: 'New session workspace', sessionCwdHint: 'Pick the DSH workspace for new sessions. "Auto" follows the most recently used workspace.',
      sessionCwdAuto: 'Auto (most recently used workspace)', sessionCwdUnregistered: 'Current setting (not registered)',
      workspacesTitle: 'Workspaces', noWorkspaces: 'No DSH workspace is registered yet.',
      unassignedWorkspace: 'Sessions outside any workspace',
      workspacesError: 'Could not load the DSH workspace list',
      configuredWorkspace: 'plugin target', pluginSessionTag: 'plugin',
      sessionUnknown: 'Untitled session', lastActive: 'Last activity',
      sessionModel: 'New session model', sessionModelDefault: 'Use the DSH default model',
      judgeModel: 'Precheck model', judgeModelDefault: 'Follow the session model',
      judgeModelHint: 'Pin a fast, lightweight model here so the need-to-handle judgment returns quickly; new sessions keep using the session model above.',
      sessionModelPinDefault: 'Pin the current default model', sessionModelFixedHint: 'Selecting a concrete model pins every new session to that provider/model; it will not follow future default changes.',
      sessionModelUnavailable: 'Currently configured model (not in the available catalog)',
      modelCatalogError: 'Could not load the available model catalog',
      autoProcess: 'Automatically open sessions only for direct comment mentions from other users',
      precheckEnabled: 'Fast pre-judgment during each poll: mentions that need no handling are marked done directly, in parallel, without opening sessions',
      ruleSkipEnabled: 'Mark pipeline notifications, self-mentions, and description-body mentions done directly by rule (no model call)',
      autoArchive: 'Archive plugin sessions once their loop is closed or a follow-up is scheduled (sessions that need a human stay unarchived)',
      followUpEnabled: 'Close the loop automatically: when a session ends without closing its todo, open a follow-up session later',
      maxFollowUps: 'Maximum automatic follow-up rounds per todo', followUpDelay: 'Follow-up wait (minutes)',
      followUpHint: 'A loop is closed when the todo is marked done and the original note has our reply. Waiting on CI and similar conditions is retried after the wait (doubling each round); when rounds run out, or the session reports that a human is needed, the todo is left for you.',
      closureClosed: 'Loop closed', closureFollowUp: 'Follow-up scheduled', closureNeedsHuman: 'Needs you', closureVerifying: 'Verifying',
      followUpCount: 'Awaiting follow-up', needsHumanCount: 'Needs you',
      roundLabel: 'Round', nextAttempt: 'Next follow-up',
      loading: 'Loading GitLab Todo panel…', renderError: 'The panel failed to render', retry: 'Retry rendering',
      localError: 'Action failed',
      defaultPaused: 'Polling starts paused so installation never dispatches your real todos automatically.',
    };
    const zh = {
      panel: 'GitLab Todo', title: 'GitLab Todo 轮询助手',
      subtitle: '直接读取 GitLab Todo，仅自动处理他人在评论中直接 @ 你的事项。',
      enable: '启用轮询', disable: '停用轮询', checkNow: '立即检查', checking: '检查中…',
      settings: '设置', save: '保存设置', cancel: '取消', close: '关闭',
      enabled: '已启用', disabled: '已停用', running: '运行中', idle: '空闲',
      activeSessions: '自动会话运行中', queuedSessions: '排队待分派',
      pending: '待处理', handled: '已处理', lastSuccess: '最近成功轮询', never: '从未',
      mrDone: 'MR 已直接标记完成', markDone: '标记完成',
      newFound: '最近一次结果中尚未接受的 Todo',
      todoList: 'Todo 列表', noTodos: '当前没有 Todo，可点击“立即检查”刷新。',
      directMention: '评论中 @ 我',
      sessionsTitle: '最近会话', noSessions: '还没有分派过会话。', autoDispatch: '自动', manualDispatch: '手动',
      loadMore: '加载更多', sessionsError: '无法加载最近会话列表',
      archiveSession: '归档', unarchiveSession: '取消归档',
      sessionStarting: '启动中', sessionAccepted: '已入队',
      process: '开 Session 处理', reprocess: '重新处理', dispatched: '已接受', waiting: '待处理',
      executionRunning: '执行中', executionCompleted: '执行完成', executionFailed: '执行失败',
      precheckSkipped: '已跳过（无需处理）',
      ruleSkipped: '已跳过（规则）',
      sessionArchived: '已归档',
      openSession: '打开 Session',
      interval: '轮询间隔（秒）', limit: '每轮最多创建 Session 数', concurrency: '自动处理并发数',
      cwd: 'GitLab 工作目录', cwdHint: '留空使用 Host 进程目录。',
      sessionCwd: '新开会话的工作区', sessionCwdHint: '选择新会话归属的 DSH 工作区；“自动”跟随最近使用的工作区。',
      sessionCwdAuto: '自动（最近使用的工作区）', sessionCwdUnregistered: '当前配置（未注册）',
      workspacesTitle: '工作区', noWorkspaces: 'DSH 尚未注册工作区。',
      unassignedWorkspace: '未归属工作区的会话',
      workspacesError: '无法加载 DSH 工作区列表',
      configuredWorkspace: '插件目标', pluginSessionTag: '插件',
      sessionUnknown: '未命名会话', lastActive: '最近活动',
      sessionModel: '新开会话使用的模型', sessionModelDefault: '跟随 DSH 默认模型',
      judgeModel: '预检模型', judgeModelDefault: '跟随会话模型',
      judgeModelHint: '固定一个更快的轻量模型可显著缩短“是否需要处理”的判断耗时；新会话仍使用上面的会话模型。',
      sessionModelPinDefault: '固定当前默认模型', sessionModelFixedHint: '选择具体模型后，新会话会固定使用该 provider/model，不再随 DSH 默认模型变化。',
      sessionModelUnavailable: '当前配置模型（不在可用目录中）',
      modelCatalogError: '无法加载可用模型目录',
      autoProcess: '仅为其他用户在评论中直接 @ 我的 Todo 自动创建 Session',
      precheckEnabled: '每轮轮询先并行快速预判：不需要处理的提及直接标记完成，不开会话',
      ruleSkipEnabled: '流水线通知、自己 @ 自己、正文 @ 提及等规则噪声直接标记完成，不经过模型',
      autoArchive: '闭环或已排续办后自动归档会话（仅插件创建的会话；需人工接手的保留不归档）',
      followUpEnabled: '自动续办：会话结束但 Todo 没有闭环时，稍后自动新开续办会话',
      maxFollowUps: '每条 Todo 最多自动续办轮数', followUpDelay: '续办等待时间（分钟）',
      followUpHint: '闭环 = Todo 已标记完成且原 note 有我方回复。等待 CI 等条件的按等待时间续办（逐轮翻倍）；轮数用尽或会话判定需要人接手时，保留给你处理。',
      closureClosed: '已闭环', closureFollowUp: '待续办', closureNeedsHuman: '需人工', closureVerifying: '核对中',
      followUpCount: '待续办', needsHumanCount: '需人工',
      roundLabel: '轮次', nextAttempt: '下次续办',
      loading: '正在加载 GitLab Todo 面板…', renderError: '面板渲染失败', retry: '重新渲染',
      localError: '操作失败',
      defaultPaused: '插件默认停用，避免安装后立即处理真实 Todo。',
    };

    async function bridge(action, options = {}) {
      const method = options.method ?? (action === 'state' || action === 'models' || action === 'workspaces' ? 'GET' : 'POST');
      const headers = { Accept: 'application/json' };
      if (method === 'POST') headers['Content-Type'] = 'application/json';
      const query = method === 'GET' ? `?action=${encodeURIComponent(action)}` : '';
      const response = await fetch(`${BRIDGE_PATH}${query}`, {
        method,
        headers,
        body: method === 'POST' ? JSON.stringify({ action, ...(options.payload ?? {}) }) : undefined,
      });
      const data = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
      if (!response.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${response.status}`);
      return data;
    }

    const getState = async () => (await bridge('state')).state;
    const post = (action, payload) => bridge(action, { payload });

    function formatTime(value, fallback) {
      return value ? new Date(value).toLocaleString() : fallback;
    }

    function isMergeRequest(todo) {
      return String(todo.targetType ?? '').toLowerCase().replace(/[^a-z]/g, '') === 'mergerequest'
        || /\/-\/merge_requests(?:\/|$)/i.test(todo.url ?? '');
    }

    function todoStatusLabel(todo, t) {
      if (todo.outcome === 'merge-request-done') return t('mrDone');
      if (todo.outcome === 'precheck-skipped') return t('precheckSkipped');
      if (todo.outcome === 'rule-skipped') return t('ruleSkipped');
      if (todo.executionStatus === 'running') return t('executionRunning');
      const closure = closureLabel(todo.closure, t);
      if (closure) return closure;
      if (todo.executionStatus === 'completed') return t('executionCompleted');
      if (todo.executionStatus === 'failed') return t('executionFailed');
      return todo.handled ? t('dispatched') : t('waiting');
    }

    /** 闭环状态标签；旧记录或尚未结算的记录没有闭环状态，返回空串。 */
    function closureLabel(closure, t) {
      if (closure === 'closed') return t('closureClosed');
      if (closure === 'follow-up') return t('closureFollowUp');
      if (closure === 'needs-human') return t('closureNeedsHuman');
      if (closure === 'verifying') return t('closureVerifying');
      return '';
    }

    /** 列表里的闭环补充信息：第几轮、结论说明、下次续办时间。 */
    function closureMeta(record, t) {
      return [
        record.round > 1 && `${t('roundLabel')} ${record.round}`,
        record.closureNote,
        record.closure === 'follow-up' && record.nextAttemptAt && `${t('nextAttempt')} ${formatTime(record.nextAttemptAt, '')}`,
      ].filter(Boolean);
    }

    /**
     * 模型选项的 value 编码：JSON.stringify({provider, model})。
     * 必须与 sessionModel 设置的对象形状一一对应（onChange 直接 JSON.parse 回对象），
     * 不可用数组形式，否则解析结果缺少 provider/model 字段。
     */
    function sessionModelKey(selection) {
      if (!selection) return '';
      return JSON.stringify({
        provider: typeof selection.provider === 'string' ? selection.provider : '',
        model: typeof selection.model === 'string' ? selection.model : '',
      });
    }

    function PanelIcon({ size = 20 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('rect', { x: 4, y: 3, width: 16, height: 18, rx: 3 }),
        h('path', { d: 'm8 8 1.5 1.5L12 6M8 13l1.5 1.5L12 11M14 8h3M14 13h3M9 18a4 4 0 0 0 6-3M15 12v3h-3' }),
      );
    }

    function Button(props) {
      return h('button', {
        type: 'button',
        className: `gta-button ${props.primary ? 'gta-primary' : ''}`,
        disabled: props.disabled,
        onClick: props.onClick,
        title: props.title,
      }, props.children);
    }

    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      componentDidCatch(error, info) {
        console.error('[gitlab-todo-agent] panel render failed', error, info);
      }
      render() {
        if (!this.state.error) return this.props.children;
        const t = this.props.t;
        return h('div', { className: 'gta-root' },
          h('style', { children: CSS }),
          h('div', { className: 'gta-fatal', role: 'alert' },
            h('h1', null, t('renderError')),
            h('p', null, this.state.error.message ?? String(this.state.error)),
            h(Button, { onClick: () => this.setState({ error: null }) }, t('retry')),
          ),
        );
      }
    }

    function TodoPanel({ ctx, t }) {
      const [snapshot, setSnapshot] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [activeTab, setActiveTab] = React.useState('todos');
      const [modelCatalog, setModelCatalog] = React.useState(null);
      const [modelCatalogError, setModelCatalogError] = React.useState(null);
      const [workspaceData, setWorkspaceData] = React.useState(null);
      const [workspaceError, setWorkspaceError] = React.useState(null);

      React.useEffect(() => {
        let disposed = false;
        bridge('models').then((data) => {
          if (!disposed) setModelCatalog(data.catalog);
        }).catch((cause) => {
          if (!disposed) setModelCatalogError(cause.message);
        });
        return () => { disposed = true; };
      }, []);

      // 工作区列表：挂载时先拉一次供 Tab 计数与设置下拉使用；
      // 打开“工作区”Tab 或设置面板时再按 10s 间隔刷新。
      React.useEffect(() => {
        let disposed = false;
        bridge('workspaces').then((data) => {
          if (!disposed) setWorkspaceData(Array.isArray(data.workspaces) ? data.workspaces : []);
        }).catch(() => {});
        return () => { disposed = true; };
      }, []);

      // 最近会话（分页）：首页 30 条，“加载更多”按 offset 追加；
      // 会话页打开期间每 10s 静默刷新已加载范围（刷新不重置已翻页）。
      const [sessionData, setSessionData] = React.useState(null);
      const [sessionError, setSessionError] = React.useState(null);
      const [sessionBusy, setSessionBusy] = React.useState(false);
      const sessionInFlight = React.useRef(false);
      const sessionDataRef = React.useRef(null);
      const applySessionPage = (page, append) => {
        const previous = sessionDataRef.current;
        const items = append && previous ? [...previous.items, ...page.items] : page.items;
        const next = { ...page, items };
        sessionDataRef.current = next;
        setSessionData(next);
      };
      const fetchSessions = async (append) => {
        if (sessionInFlight.current) return;
        sessionInFlight.current = true;
        setSessionBusy(true);
        try {
          const loaded = sessionDataRef.current?.items?.length ?? 0;
          const request = append
            ? { offset: loaded, limit: 30 }
            : { offset: 0, limit: Math.max(30, loaded) };
          applySessionPage(await post('sessions', request), append);
          setSessionError(null);
        } catch (cause) {
          setSessionError(cause.message);
        } finally {
          sessionInFlight.current = false;
          setSessionBusy(false);
        }
      };
      const refreshSessions = () => fetchSessions(false);
      React.useEffect(() => {
        if (activeTab !== 'sessions') return undefined;
        void refreshSessions();
        const timer = setInterval(() => void refreshSessions(), 10000);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [activeTab]);

      const needWorkspacePolling = activeTab === 'workspaces' || Boolean(draft);
      React.useEffect(() => {
        if (!needWorkspacePolling) return undefined;
        let disposed = false;
        const load = async () => {
          try {
            const data = await bridge('workspaces');
            if (!disposed) {
              setWorkspaceData(Array.isArray(data.workspaces) ? data.workspaces : []);
              setWorkspaceError(null);
            }
          } catch (cause) {
            if (!disposed) setWorkspaceError(cause.message);
          }
        };
        void load();
        const timer = setInterval(load, 10000);
        return () => { disposed = true; clearInterval(timer); };
      }, [needWorkspacePolling]);

      React.useEffect(() => {
        let disposed = false;
        const load = async () => {
          try {
            const next = await getState();
            if (!disposed) setSnapshot(next);
          } catch (cause) {
            if (!disposed) setError(cause.message);
          }
        };
        void load();
        const timer = setInterval(load, 3000);
        return () => {
          disposed = true;
          clearInterval(timer);
        };
      }, []);

      const perform = async (key, operation) => {
        if (busy) return false;
        setBusy(key);
        setError(null);
        try {
          const data = await operation();
          if (data.state) setSnapshot(data.state);
          if (data.result && data.result.ok === false) throw new Error(data.result.error);
          return true;
        } catch (cause) {
          setError(cause.message);
          return false;
        } finally {
          setBusy('');
        }
      };

      const updateSettings = (settings) => perform('settings', () => post('updateSettings', { settings }));
      const saveGeneralSettings = () => updateSettings(draft);
      const openSession = (sessionId) => ctx.uiWorkspace.openSession(sessionId);
      // 快捷切换归档状态：成功后连同最近会话页一起刷新。
      const toggleSessionArchive = (record) => perform(`archive:${record.sessionId}`, () => post('setSessionArchived', {
        sessionId: record.sessionId,
        archived: record.archived !== true,
      })).then((done) => {
        if (done) void refreshSessions();
      });
      const settings = snapshot?.settings;
      // 与 task-board 的 model-options 实现一致：直接遍历目录 groups，不按 routableProviders 二次过滤。
      const modelGroups = (Array.isArray(modelCatalog?.groups) ? modelCatalog.groups : [])
        .filter((group) => Array.isArray(group?.models) && group.models.length > 0);
      const availableModelKeys = new Set(modelGroups.flatMap((group) => group.models.map((model) => sessionModelKey({ provider: group.id ?? group.provider, model: model.id }))));
      const pinnedDefaultKey = sessionModelKey(modelCatalog?.default);
      const modelOptions = (selection, followLabel) => {
        const follow = followLabel ?? t('sessionModelDefault');
        const hasFields = typeof selection?.provider === 'string' && selection.provider
          && typeof selection?.model === 'string' && selection.model;
        const selectedKey = hasFields ? sessionModelKey(selection) : '';
        return [
          h('option', { value: '' }, `${follow}${modelCatalog?.default ? ` (${modelCatalog.default.model})` : ''}`),
          pinnedDefaultKey && !availableModelKeys.has(pinnedDefaultKey) && h('option', { value: pinnedDefaultKey }, `${t('sessionModelPinDefault')} (${modelCatalog.default.model} · ${modelCatalog.default.provider})`),
          selectedKey && selectedKey !== pinnedDefaultKey && !availableModelKeys.has(selectedKey) && h('option', { value: selectedKey }, `${t('sessionModelUnavailable')}: ${selection.provider}/${selection.model}`),
          modelGroups.map((group) => h('optgroup', { key: group.id ?? group.provider, label: group.name ?? group.id ?? group.provider }, group.models.map((model) =>
            h('option', { key: model.id, value: sessionModelKey({ provider: group.id ?? group.provider, model: model.id }) }, `${model.name ?? model.id} · ${model.id}`),
          ))),
        ];
      };
      const quickModelKey = sessionModelKey(settings?.sessionModel);
      // 工作区下拉：值仍是工作区路径（sessionCwd 语义不变）；比较忽略大小写/斜杠差异。
      const workspaceOptions = Array.isArray(workspaceData) ? workspaceData : [];
      const normalizePathKey = (value) => String(value ?? '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
      const registeredWorkspacePaths = new Set(workspaceOptions.map((workspace) => normalizePathKey(workspace.path)));
      const draftSessionCwdUnregistered = Boolean(draft?.sessionCwd) && !registeredWorkspacePaths.has(normalizePathKey(draft.sessionCwd));
      const sessionDisplayName = (session, label, workspacePath) => {
        if (session.sessionTitle) return session.sessionTitle;
        const sameAsWorkspace = workspacePath && normalizePathKey(session.cwd) === normalizePathKey(workspacePath);
        if (session.cwd && !sameAsWorkspace) {
          return String(session.cwd).split(/[\\/]+/).filter(Boolean).pop();
        }
        return label;
      };

      return h('div', { className: 'gta-root' },
        h('style', { children: CSS }),
        h('header', { className: 'gta-header' },
          h('div', { className: 'gta-heading' },
            h('div', { className: 'gta-title-row' },
              h('span', { className: 'gta-title-icon' }, h(PanelIcon, { size: 24 })),
              h('h1', null, t('title')),
            ),
            h('p', null, t('subtitle')),
          ),
          h('div', { className: 'gta-actions' },
            h('label', { className: 'gta-model-quick', title: t('sessionModelFixedHint') },
              h('span', null, t('sessionModel')),
              h('select', {
                value: quickModelKey,
                disabled: !snapshot || Boolean(busy),
                'aria-label': t('sessionModel'),
                onChange: (event) => updateSettings({ sessionModel: event.target.value ? JSON.parse(event.target.value) : null }),
              }, modelOptions(settings?.sessionModel)),
            ),
            h(Button, {
              primary: !settings?.enabled,
              disabled: Boolean(busy) || !snapshot,
              onClick: () => updateSettings({ enabled: !settings.enabled }),
            }, settings?.enabled ? t('disable') : t('enable')),
            h(Button, {
              disabled: Boolean(busy) || !snapshot,
              onClick: () => perform('poll', () => post('poll')),
            }, busy === 'poll' ? t('checking') : t('checkNow')),
            h(Button, {
              disabled: !snapshot,
              onClick: () => setDraft(draft ? null : { ...settings }),
            }, draft ? t('close') : t('settings')),
          ),
        ),
        h('p', { className: 'gta-muted gta-paused' }, t('defaultPaused')),
        !snapshot && !error && h('div', { className: 'gta-empty' }, t('loading')),
        error && h('div', { className: 'gta-banner gta-error', role: 'alert' }, `${t('localError')}：${error}`),
        snapshot?.lastPollError && h('div', { className: 'gta-banner gta-error', role: 'alert' }, snapshot.lastPollError),
        snapshot?.lastDispatchError && h('div', { className: 'gta-banner gta-warn', role: 'status' }, snapshot.lastDispatchError),
        modelCatalogError && h('div', { className: 'gta-banner gta-warn', role: 'status' }, `${t('modelCatalogError')}：${modelCatalogError}`),
        draft && h('section', { className: 'gta-card gta-settings' },
          h('h2', null, t('settings')),
          h('div', { className: 'gta-form-grid' },
            h('label', null, t('interval'), h('input', {
              type: 'number', min: 30, max: 86400, value: draft.intervalSeconds,
              onChange: (event) => setDraft({ ...draft, intervalSeconds: Number(event.target.value) }),
            })),
            h('label', null, t('limit'), h('input', {
              type: 'number', min: 1, max: 10, value: draft.maxSessionsPerPoll,
              onChange: (event) => setDraft({ ...draft, maxSessionsPerPoll: Number(event.target.value) }),
            })),
            h('label', null, t('concurrency'), h('input', {
              type: 'number', min: 1, max: 10, value: draft.maxConcurrentSessions,
              onChange: (event) => setDraft({ ...draft, maxConcurrentSessions: Number(event.target.value) }),
            })),
            h('label', null, t('sessionModel'), h('select', {
              value: sessionModelKey(draft.sessionModel),
              onChange: (event) => setDraft({
                ...draft,
                sessionModel: event.target.value ? JSON.parse(event.target.value) : null,
              }),
            }, modelOptions(draft.sessionModel))),
            h('label', null, t('judgeModel'), h('select', {
              value: sessionModelKey(draft.judgeModel),
              onChange: (event) => setDraft({
                ...draft,
                judgeModel: event.target.value ? JSON.parse(event.target.value) : null,
              }),
            }, modelOptions(draft.judgeModel, t('judgeModelDefault')))),
            h('p', { className: 'gta-muted gta-wide' }, t('sessionModelFixedHint')),
            h('p', { className: 'gta-muted gta-wide' }, t('judgeModelHint')),
            h('label', { className: 'gta-wide' }, t('sessionCwd'), h('select', {
              value: draft.sessionCwd,
              onChange: (event) => setDraft({ ...draft, sessionCwd: event.target.value }),
            },
              h('option', { value: '' }, t('sessionCwdAuto')),
              draftSessionCwdUnregistered && h('option', { value: draft.sessionCwd }, `${t('sessionCwdUnregistered')}：${draft.sessionCwd}`),
              workspaceOptions.map((workspace) => h('option', { key: workspace.workspaceId, value: workspace.path },
                `${workspace.title || workspace.path} · ${workspace.path}`)),
            ), h('span', { className: 'gta-muted' }, t('sessionCwdHint'))),
            h('label', { className: 'gta-wide' }, t('cwd'), h('input', {
              type: 'text', value: draft.cwd, placeholder: t('cwdHint'),
              onChange: (event) => setDraft({ ...draft, cwd: event.target.value }),
            })),
            h('label', null, t('maxFollowUps'), h('input', {
              type: 'number', min: 0, max: 10, value: draft.maxFollowUps ?? 3, disabled: draft.followUpEnabled === false,
              onChange: (event) => setDraft({ ...draft, maxFollowUps: Number(event.target.value) }),
            })),
            h('label', null, t('followUpDelay'), h('input', {
              type: 'number', min: 1, max: 1440, value: draft.followUpDelayMinutes ?? 15, disabled: draft.followUpEnabled === false,
              onChange: (event) => setDraft({ ...draft, followUpDelayMinutes: Number(event.target.value) }),
            })),
            h('p', { className: 'gta-muted gta-wide' }, t('followUpHint')),
          ),
          h('label', { className: 'gta-check' }, h('input', {
            type: 'checkbox', checked: draft.autoProcess,
            onChange: (event) => setDraft({ ...draft, autoProcess: event.target.checked }),
          }), t('autoProcess')),
          h('label', { className: 'gta-check' }, h('input', {
            type: 'checkbox', checked: draft.precheckEnabled,
            onChange: (event) => setDraft({ ...draft, precheckEnabled: event.target.checked }),
          }), t('precheckEnabled')),
          h('label', { className: 'gta-check' }, h('input', {
            type: 'checkbox', checked: draft.ruleSkipEnabled,
            onChange: (event) => setDraft({ ...draft, ruleSkipEnabled: event.target.checked }),
          }), t('ruleSkipEnabled')),
          h('label', { className: 'gta-check' }, h('input', {
            type: 'checkbox', checked: draft.autoArchive,
            onChange: (event) => setDraft({ ...draft, autoArchive: event.target.checked }),
          }), t('autoArchive')),
          h('label', { className: 'gta-check' }, h('input', {
            type: 'checkbox', checked: draft.followUpEnabled !== false,
            onChange: (event) => setDraft({ ...draft, followUpEnabled: event.target.checked }),
          }), t('followUpEnabled')),
          h('div', { className: 'gta-form-actions' },
            h(Button, { primary: true, disabled: Boolean(busy), onClick: () => saveGeneralSettings().then((saved) => { if (saved) setDraft(null); }) }, t('save')),
            h(Button, { disabled: Boolean(busy), onClick: () => setDraft(null) }, t('cancel')),
          ),
        ),
        snapshot && h('section', { className: 'gta-stats' },
          h('div', { className: 'gta-stat' }, h('span', null, t('enabled')), h('strong', { className: snapshot.settings.enabled ? 'gta-success' : 'gta-muted' }, snapshot.settings.enabled ? t('enabled') : t('disabled'))),
          h('div', { className: 'gta-stat' }, h('span', null, t('running')), h('strong', null, snapshot.running ? t('running') : t('idle'))),
          h('div', { className: 'gta-stat' }, h('span', null, t('pending')), h('strong', null, snapshot.pendingCount)),
          h('div', { className: 'gta-stat' }, h('span', null, t('handled')), h('strong', null, snapshot.handledCount)),
          h('div', { className: 'gta-stat' }, h('span', null, t('activeSessions')), h('strong', { className: snapshot.activeSessions > 0 ? 'gta-success' : '' }, `${snapshot.activeSessions ?? 0}/${snapshot.settings.maxConcurrentSessions}`)),
          h('div', { className: 'gta-stat' }, h('span', null, t('queuedSessions')), h('strong', null, snapshot.queuedSessions ?? 0)),
          h('div', { className: 'gta-stat' }, h('span', null, t('followUpCount')), h('strong', null, snapshot.closure?.followUp ?? 0)),
          h('div', { className: 'gta-stat' }, h('span', null, t('needsHumanCount')), h('strong', { className: (snapshot.closure?.needsHuman ?? 0) > 0 ? 'gta-attention' : '' }, snapshot.closure?.needsHuman ?? 0)),
          h('div', { className: 'gta-stat gta-stat-time' }, h('span', null, t('lastSuccess')), h('strong', null, formatTime(snapshot.lastSuccessAt, t('never')))),
        ),
        snapshot && h('div', { className: 'gta-tabs', role: 'tablist' },
          h('button', {
            type: 'button', role: 'tab', id: `${PANEL_ID}-tab-todos`, 'aria-selected': activeTab === 'todos',
            'aria-controls': `${PANEL_ID}-panel-todos`,
            className: `gta-tab${activeTab === 'todos' ? ' gta-tab-active' : ''}`,
            onClick: () => setActiveTab('todos'),
          }, `${t('todoList')} (${snapshot.todos.length})`),
          h('button', {
            type: 'button', role: 'tab', id: `${PANEL_ID}-tab-sessions`, 'aria-selected': activeTab === 'sessions',
            'aria-controls': `${PANEL_ID}-panel-sessions`,
            className: `gta-tab${activeTab === 'sessions' ? ' gta-tab-active' : ''}`,
            onClick: () => setActiveTab('sessions'),
          }, `${t('sessionsTitle')} (${sessionData?.total ?? (snapshot.sessions ?? []).length})`),
          h('button', {
            type: 'button', role: 'tab', id: `${PANEL_ID}-tab-workspaces`, 'aria-selected': activeTab === 'workspaces',
            'aria-controls': `${PANEL_ID}-panel-workspaces`,
            className: `gta-tab${activeTab === 'workspaces' ? ' gta-tab-active' : ''}`,
            onClick: () => setActiveTab('workspaces'),
          }, `${t('workspacesTitle')} (${workspaceOptions.length})`),
        ),
        activeTab === 'todos' && snapshot && h('section', { className: 'gta-section', role: 'tabpanel', id: `${PANEL_ID}-panel-todos`, 'aria-labelledby': `${PANEL_ID}-tab-todos` },
          h('div', { className: 'gta-section-title' }, h('h2', null, t('todoList')), h('span', { className: 'gta-muted' }, `${t('newFound')}：${snapshot.lastNewCount}`)),
          snapshot.todos.length === 0
            ? h('div', { className: 'gta-empty' }, t('noTodos'))
            : h('div', { className: 'gta-list gta-scroll-list', role: 'list', 'aria-label': t('todoList') }, snapshot.todos.map((todo) =>
                h('article', { className: 'gta-todo', key: todo.id },
                  h('div', { className: 'gta-todo-main' },
                    h('div', { className: 'gta-todo-title' },
                      todo.url
                        ? h('a', { href: todo.url, target: '_blank', rel: 'noreferrer' }, todo.title)
                        : h('span', null, todo.title),
                      todo.directMention && h('span', { className: 'gta-tag gta-tag-mention' }, t('directMention')),
                      h('span', { className: `gta-tag ${(todo.executionStatus === 'completed' && (!todo.closure || todo.closure === 'closed')) || todo.outcome === 'merge-request-done' || todo.outcome === 'precheck-skipped' ? 'gta-tag-success' : ''}` }, todoStatusLabel(todo, t)),
                    ),
                    h('div', { className: 'gta-muted gta-meta' }, [`#${todo.id}`, todo.project, todo.targetType, todo.action, todo.author && `@${todo.author}`, todo.skipReason, ...closureMeta(todo, t)].filter(Boolean).join(' · ')),
                  ),
                  h('div', { className: 'gta-todo-actions' },
                    todo.sessionId && h(Button, { onClick: () => openSession(todo.sessionId) }, t('openSession')),
                    (!todo.handled || todo.outcome !== 'merge-request-done') && h(Button, {
                      primary: !todo.handled,
                      disabled: Boolean(busy) || todo.executionStatus === 'running',
                      onClick: () => perform(`dispatch:${todo.id}`, () => post('dispatch', { id: todo.id })),
                    }, busy === `dispatch:${todo.id}` ? '…' : todo.handled ? t('reprocess') : isMergeRequest(todo) && !todo.directMention ? t('markDone') : t('process')),
                  ),
                ),
              )),
        ),
        activeTab === 'sessions' && snapshot && h('section', { className: 'gta-section', role: 'tabpanel', id: `${PANEL_ID}-panel-sessions`, 'aria-labelledby': `${PANEL_ID}-tab-sessions` },
          h('div', { className: 'gta-section-title' }, h('h2', null, t('sessionsTitle')), h('span', { className: 'gta-muted' },
            sessionData ? `${sessionData.items.length}/${sessionData.total}` : `${(snapshot.sessions ?? []).length}`)),
          sessionError && h('div', { className: 'gta-banner gta-warn', role: 'status' }, `${t('sessionsError')}：${sessionError}`),
          !sessionData && !sessionError && h('div', { className: 'gta-empty' }, t('loading')),
          sessionData && sessionData.total === 0 && h('div', { className: 'gta-empty' }, t('noSessions')),
          sessionData && sessionData.items.length > 0 && h('div', { className: 'gta-list gta-scroll-list gta-session-list', role: 'list', 'aria-label': t('sessionsTitle') }, sessionData.items.map((record) =>
                h('article', { className: 'gta-todo', key: record.sessionId },
                  h('div', { className: 'gta-todo-main' },
                    h('div', { className: 'gta-todo-title' },
                      record.url
                        ? h('a', { href: record.url, target: '_blank', rel: 'noreferrer', title: record.sessionId }, record.title)
                        : h('span', { title: record.sessionId }, record.title),
                      h('span', { className: `gta-tag ${record.executionStatus === 'completed' ? 'gta-tag-success' : ''}` },
                        record.executionStatus === 'running' ? t('executionRunning')
                          : record.executionStatus === 'completed' ? t('executionCompleted')
                          : record.executionStatus === 'failed' ? t('executionFailed')
                          : record.executionStatus === 'starting' ? t('sessionStarting')
                          : t('sessionAccepted')),
                      closureLabel(record.closure, t) && h('span', { className: `gta-tag ${record.closure === 'closed' ? 'gta-tag-success' : ''}` }, closureLabel(record.closure, t)),
                      h('span', { className: 'gta-tag gta-tag-mention' }, record.automatic ? t('autoDispatch') : t('manualDispatch')),
                      record.archived && h('span', { className: 'gta-tag gta-tag-success' }, t('sessionArchived')),
                    ),
                    h('div', { className: 'gta-muted gta-meta' },
                      [record.sessionTitle, record.project, record.executionError, ...closureMeta(record, t), record.archiveError].filter(Boolean).join(' · ')),
                  ),
                  h('div', { className: 'gta-todo-actions' },
                    !record.archived && h(Button, { onClick: () => openSession(record.sessionId) }, t('openSession')),
                    record.executionStatus !== 'starting' && h(Button, {
                      disabled: Boolean(busy) || (record.archived !== true && record.executionStatus === 'running'),
                      onClick: () => toggleSessionArchive(record),
                    }, busy === `archive:${record.sessionId}` ? '…' : (record.archived ? t('unarchiveSession') : t('archiveSession'))),
                  ),
                ),
              )),
          sessionData && sessionData.items.length < sessionData.total && h('div', { className: 'gta-load-more' },
            h(Button, { disabled: Boolean(sessionBusy), onClick: () => fetchSessions(true) }, sessionBusy ? '…' : t('loadMore'))),
        ),
        activeTab === 'workspaces' && h('section', { className: 'gta-section', role: 'tabpanel', id: `${PANEL_ID}-panel-workspaces`, 'aria-labelledby': `${PANEL_ID}-tab-workspaces` },
          h('div', { className: 'gta-section-title' }, h('h2', null, t('workspacesTitle')), h('span', { className: 'gta-muted' }, `${workspaceOptions.length}`)),
          workspaceError && h('div', { className: 'gta-banner gta-warn', role: 'status' }, `${t('workspacesError')}：${workspaceError}`),
          workspaceOptions.length === 0 && !workspaceError && h('div', { className: 'gta-empty' }, t('noWorkspaces')),
          h('div', { className: 'gta-list gta-scroll-list', role: 'list', 'aria-label': t('workspacesTitle') },
            workspaceOptions.map((workspace) =>
              h('article', { className: 'gta-todo gta-workspace', key: workspace.workspaceId || 'unassigned' },
                h('div', { className: 'gta-todo-main' },
                  h('div', { className: 'gta-todo-title' },
                    h('span', { className: 'gta-workspace-name', title: workspace.path },
                      workspace.unassigned ? t('unassignedWorkspace') : workspace.title || workspace.path || workspace.workspaceId),
                    workspace.configured && h('span', { className: 'gta-tag gta-tag-mention' }, t('configuredWorkspace')),
                    h('span', { className: 'gta-muted' }, `${t('sessionsTitle')}：${workspace.sessionCount}`),
                  ),
                  h('div', { className: 'gta-muted gta-meta' },
                    [workspace.path, workspace.updatedAt ? `${t('lastActive')}：${formatTime(workspace.updatedAt, '')}` : ''].filter(Boolean).join(' · ')),
                  h('div', { className: 'gta-workspace-sessions' },
                    workspace.sessions.length === 0
                      ? h('div', { className: 'gta-muted' }, t('noSessions'))
                      : workspace.sessions.map((session) =>
                          h('div', { className: 'gta-workspace-session', key: session.sessionId },
                            session.archived
                              ? h('span', { className: 'gta-session-name', title: session.sessionId }, sessionDisplayName(session, t('sessionUnknown'), workspace.path))
                              : h('button', {
                                  type: 'button', className: 'gta-session-link', title: session.sessionId,
                                  onClick: () => openSession(session.sessionId),
                                }, sessionDisplayName(session, t('sessionUnknown'), workspace.path)),
                            h('span', { className: `gta-tag ${session.running ? '' : 'gta-tag-success'}` },
                              session.running ? t('executionRunning') : t('idle')),
                            session.plugin && h('span', { className: 'gta-tag gta-tag-mention' }, t('pluginSessionTag')),
                            session.archived && h('span', { className: 'gta-tag gta-tag-success' }, t('sessionArchived')),
                            h('span', { className: 'gta-muted gta-session-meta' },
                              [session.known ? '' : '·', session.updatedAt ? formatTime(session.updatedAt, '') : ''].filter(Boolean).join(' ')),
                          )),
                  ),
                ),
              )),
          ),
        ),
      );
    }

    const CSS = `
      .gta-root{box-sizing:border-box;width:100%;min-width:0;height:100%;min-height:320px;overflow:auto;padding:28px 32px 48px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.55}
      .gta-root *{box-sizing:border-box}.gta-root h1{font-size:24px;line-height:1.25;margin:0;font-weight:650}.gta-root h2{font-size:16px;margin:0 0 12px;font-weight:600}.gta-root p{margin:6px 0 0}
      .gta-header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;max-width:1180px;margin:0 auto}.gta-title-row{display:flex;align-items:center;gap:12px}.gta-title-icon{color:var(--dsw-alias-brand-primary);display:flex}.gta-heading p{color:var(--dsw-alias-label-secondary)}
      .gta-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}.gta-model-quick{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}.gta-model-quick select{width:auto;min-width:200px;max-width:280px}.gta-button{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:7px;padding:7px 12px;font:inherit;cursor:pointer;white-space:nowrap}.gta-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary)}.gta-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.gta-button:disabled{opacity:.45;cursor:default}.gta-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
      .gta-paused{max-width:1180px;margin:10px auto 18px!important}.gta-muted{color:var(--dsw-alias-label-secondary);font-size:12px}.gta-success{color:var(--dsw-alias-state-success-primary)}.gta-attention{color:var(--dsw-alias-state-warn-primary)}
      .gta-banner{max-width:1180px;margin:10px auto;padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1)}.gta-warn{border-color:var(--dsw-alias-state-warn-primary)}
      .gta-card,.gta-stats,.gta-section{max-width:1180px;margin:16px auto}.gta-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:18px}.gta-form-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.gta-form-grid label{display:flex;flex-direction:column;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px}.gta-wide{grid-column:1/-1}
      .gta-root input[type=text],.gta-root input[type=number],.gta-root select{width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;padding:8px 10px}.gta-check{display:flex;align-items:center;gap:8px;margin:16px 0 0}.gta-form-actions{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
      .gta-stats{display:grid;grid-template-columns:repeat(4,minmax(100px,1fr));gap:10px}.gta-stat{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;display:flex;flex-direction:column;gap:4px}.gta-stat>span{color:var(--dsw-alias-label-secondary);font-size:12px}.gta-stat>strong{font-size:18px}.gta-stat-time{grid-column:span 2}.gta-stat-time>strong{font-size:13px}
      .gta-section-title{display:flex;align-items:baseline;justify-content:space-between;gap:16px}.gta-tabs{max-width:1180px;margin:16px auto 0;display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1)}.gta-tab{appearance:none;margin-bottom:-1px;padding:9px 18px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;white-space:nowrap}.gta-tab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}.gta-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.gta-tab-active{border-bottom-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:600}.gta-list{display:flex;flex-direction:column;gap:8px}.gta-load-more{display:flex;justify-content:center;padding:10px 0 2px}.gta-scroll-list{max-height:min(52vh,480px);overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-gutter:stable;padding:2px 6px 2px 2px}.gta-scroll-list::-webkit-scrollbar{width:8px}.gta-scroll-list::-webkit-scrollbar-track{background:transparent}.gta-scroll-list::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:4px}.gta-scroll-list::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-label-tertiary,var(--dsw-alias-border-l2))}.gta-todo{display:flex;align-items:center;gap:16px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}.gta-todo-main{min-width:0;flex:1}.gta-todo-title{display:flex;align-items:center;gap:10px;font-weight:550}.gta-todo-title>a{color:var(--dsw-alias-label-primary);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gta-todo-title>a:hover{color:var(--dsw-alias-brand-primary);text-decoration:underline}.gta-tag{flex:none;font-size:11px;padding:1px 7px;border-radius:10px;color:var(--dsw-alias-state-warn-primary);border:1px solid var(--dsw-alias-state-warn-primary)}.gta-tag-success{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}.gta-tag-mention{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}.gta-meta{margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gta-todo-actions{display:flex;gap:8px;flex:none}.gta-session-list{max-height:min(40vh,360px)}
      .gta-workspace{flex-direction:column;align-items:stretch;gap:10px}.gta-workspace-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gta-workspace-sessions{display:flex;flex-direction:column;gap:6px;margin-top:4px}.gta-workspace-session{display:flex;align-items:center;gap:10px;padding:7px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);min-width:0}.gta-session-link{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-weight:550;padding:0;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto;min-width:0}.gta-session-link:hover{color:var(--dsw-alias-brand-primary);text-decoration:underline}.gta-session-name{font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto;min-width:0}.gta-session-meta{margin-left:auto;flex:none}
      .gta-empty{padding:24px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;text-align:center;color:var(--dsw-alias-label-secondary)}.gta-fatal{max-width:720px;margin:48px auto;padding:24px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}.gta-fatal p{white-space:pre-wrap;word-break:break-word;margin:12px 0 20px;color:var(--dsw-alias-state-error-primary)}
      @media(max-width:900px){.gta-root{padding:20px 18px 36px}.gta-header{flex-direction:column}.gta-actions{justify-content:flex-start}.gta-form-grid{grid-template-columns:1fr}.gta-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.gta-scroll-list{max-height:min(60vh,420px)}.gta-todo{align-items:flex-start;flex-direction:column}.gta-todo-actions{width:100%;justify-content:flex-end}}
    `;

    return {
      inject: ['slots', 'locale', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'gitlab-todo-agent: locale');
        const t = ctx.locale.bind(NS);
        function MainPanel() {
          return h(PanelBoundary, { t }, h(TodoPanel, { ctx, t }));
        }
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID, locale: NS,
        }, MainPanel));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS,
          label: () => t('panel'),
        }, PanelIcon));
      },
    };
  },
});
