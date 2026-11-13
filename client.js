window.__ModuleLoader__.load({
  id: '@lifeipkg/dsh-gitlab-todo-agent',
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
      customRules: 'Extra session rules', customRulesHint: 'Appended to every session prompt (e.g. merge-policy exemptions or workspace-specific convention files); overrides the generic prompt on conflict. Empty keeps the generic prompt.',
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
      autoProcess: 'Open sessions automatically for comment mentions from other users (directly addressed or mentioned in the body)',
      precheckEnabled: 'Fast pre-judgment during each poll: mentions that need no handling are marked done directly, in parallel, without opening sessions',
      ruleSkipEnabled: 'Mark pipeline notifications, self-mentions, and description-body mentions done directly by rule (no model call)',
      autoArchive: 'Archive plugin sessions once their loop is closed or a follow-up is scheduled (sessions that need a human stay unarchived)',
      followUpEnabled: 'Close the loop automatically: when a session ends without closing its todo, follow up later',
      waitProbeEnabled: 'Save tokens while waiting: check MRs and the thread with glab first and skip the follow-up session when nothing changed',
      followUpReuseSession: 'Save tokens on follow-ups: continue in the previous session when possible (falls back to a new session when it is gone, busy, or reused twice already)',
      maxFollowUps: 'Maximum automatic follow-up rounds per todo', followUpDelay: 'Follow-up wait (minutes)',
      followUpHint: 'A loop is closed when the todo is marked done and the original note has our reply. Waiting on CI and similar conditions is retried after the wait (doubling each round); when rounds run out, or the session reports that a human is needed, the todo is left for you.',
      closureClosed: 'Loop closed', closureFollowUp: 'Follow-up scheduled', closureNeedsHuman: 'Needs you', closureVerifying: 'Verifying',
      followUpCount: 'Awaiting follow-up', needsHumanCount: 'Needs you',
      roundLabel: 'Round', nextAttempt: 'Next follow-up',
      routeScope: 'Route scope', routeScopePlugin: 'Only plugin-created sessions', routeScopeAny: 'Any unarchived session',
      autoRoute: 'Automatically continue the same MR/Issue in its most recent session',
      busyRouteMode: 'Busy-session routing', busyRouteQueue: 'Queue after the current turn', busyRouteSteer: 'Insert at the next step of the current turn',
      maxQueuePerSession: 'Maximum unresolved todos per session',
      routeToSession: 'Route to session', routeSearch: 'Search by title, session ID, or working directory',
      routeLoading: 'Loading routable sessions…', routeEmpty: 'No sessions are available for routing.', routeNoMatches: 'No sessions match your search.',
      refresh: 'Refresh', routeSameTarget: 'Same MR/Issue', routeModeQueue: 'Queue', routeModeSteer: 'Steer',
      routeLoad: 'Load', routeNotAccepting: 'Not accepting', routeConfirm: 'Route to selected session',
      routedQueue: 'Routed · queued', routedSteer: 'Routed · steering', routeFailed: 'Could not route the todo',
      loading: 'Loading GitLab Todo panel…', renderError: 'The panel failed to render', retry: 'Retry rendering',
      localError: 'Action failed',
      defaultPaused: 'Polling starts paused so installation never dispatches your real todos automatically.',
      inboxTitle: 'Inbox', inboxEmpty: 'Nothing is waiting for you.', inboxTakeover: 'Open session to take over',
      inboxAcknowledge: 'Mark handled', inboxPendingUnconfirmed: 'Legacy message unconfirmed', inboxError: 'Could not load the inbox',
      digestTitle: 'Last 24 hours', digestShow: 'Details', digestHide: 'Hide', digestEmpty: 'No settled records in the last 24 hours.',
      replyPreview: 'Our reply',
      signatureLabel: 'Sign replies as AI-generated', signatureText: 'Signature text', signatureHint: 'When enabled, every GitLab reply ends with a one-line signature so readers know it was sent by an AI assistant. Applies to new prompts only.',
      taskModelQuestion: 'Model for questions', taskModelReview: 'Model for code review', taskModelChange: 'Model for code changes',
      taskModelDefault: 'Follow the session model',
      taskModelsHint: 'The batch precheck classifies each todo (question/review/change); each class can use a different model. Unset classes and routed todos use the session model.',
      confirmMarkDone: 'Confirm mark done?', confirmReprocess: 'Confirm process again?', confirmAcknowledge: 'Confirm mark handled?',
      signaturePlaceholder: '— Replied by the AI assistant',
      bridgeTimeout: 'Request timed out (90 seconds). Please try again.', bridgeNetwork: 'Network error: could not reach the plugin service.',
      colon: ': ',
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
      customRules: '会话附加规则', customRulesHint: '追加到每个会话提示词末尾的额外规则（例如 MR 合并授权豁免、工作区专属约定文件），与其他条款冲突时优先适用；留空使用通用提示词。',
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
      autoProcess: '为其他用户在评论中 @ 我的 Todo（直接提及或文中提及）自动创建 Session',
      precheckEnabled: '每轮轮询先并行快速预判：不需要处理的提及直接标记完成，不开会话',
      ruleSkipEnabled: '流水线通知、自己 @ 自己、正文 @ 提及等规则噪声直接标记完成，不经过模型',
      autoArchive: '闭环或已排续办后自动归档会话（仅插件创建的会话；需人工接手的保留不归档）',
      followUpEnabled: '自动续办：会话结束但 Todo 没有闭环时，稍后自动续办',
      waitProbeEnabled: '等待期省 token：续办到期先用 glab 探测 MR 与讨论串，没有变化就不开会话',
      followUpReuseSession: '续办省 token：优先在上一轮的会话里接力（会话已不存在、仍在执行或已接力 2 次时改为新开）',
      maxFollowUps: '每条 Todo 最多自动续办轮数', followUpDelay: '续办等待时间（分钟）',
      followUpHint: '闭环 = Todo 已标记完成且原 note 有我方回复。等待 CI 等条件的按等待时间续办（逐轮翻倍）；轮数用尽或会话判定需要人接手时，保留给你处理。',
      closureClosed: '已闭环', closureFollowUp: '待续办', closureNeedsHuman: '需人工', closureVerifying: '核对中',
      followUpCount: '待续办', needsHumanCount: '需人工',
      roundLabel: '轮次', nextAttempt: '下次续办',
      routeScope: '路由范围', routeScopePlugin: '仅插件创建的会话', routeScopeAny: '任意未归档会话',
      autoRoute: '同一 MR/Issue 自动续到最近会话',
      busyRouteMode: '忙碌会话路由方式', busyRouteQueue: '当前回合结束后处理', busyRouteSteer: '插入当前回合的下一步引导',
      maxQueuePerSession: '每个会话最大未结算任务数',
      routeToSession: '路由到会话', routeSearch: '按标题、sessionId 或 cwd 搜索',
      routeLoading: '正在加载可路由会话…', routeEmpty: '当前没有可路由的会话。', routeNoMatches: '没有符合搜索条件的会话。',
      refresh: '刷新', routeSameTarget: '同目标', routeModeQueue: '排队', routeModeSteer: '引导',
      routeLoad: '负载', routeNotAccepting: '不接受', routeConfirm: '确认路由到所选会话',
      routedQueue: '已路由·排队', routedSteer: '已路由·引导', routeFailed: '路由 Todo 失败',
      loading: '正在加载 GitLab Todo 面板…', renderError: '面板渲染失败', retry: '重新渲染',
      localError: '操作失败',
      defaultPaused: '插件默认停用，避免安装后立即处理真实 Todo。',
      inboxTitle: '收件箱', inboxEmpty: '没有等待你处理的 Todo。', inboxTakeover: '打开会话接手',
      inboxAcknowledge: '我已处理', inboxPendingUnconfirmed: '旧消息未确认', inboxError: '无法加载收件箱',
      digestTitle: '过去 24 小时', digestShow: '查看明细', digestHide: '收起明细', digestEmpty: '过去 24 小时没有结算记录。',
      replyPreview: '我方回复',
      signatureLabel: '回复署名（AI 代发标识）', signatureText: '署名文本', signatureHint: '开启后，新会话的每条 GitLab 回复末尾单独一行加上署名，让对方知道由 AI 助手代复。只影响之后派发的会话。',
      taskModelQuestion: '咨询问答模型', taskModelReview: '代码审查模型', taskModelChange: '代码修改模型',
      taskModelDefault: '跟随会话模型',
      taskModelsHint: '批量预检会为每条 Todo 分类（question/review/change）；各类可固定不同模型，未配置的类型与路由到已有会话的 Todo 使用会话模型。',
      confirmMarkDone: '确认标记完成？', confirmReprocess: '确认重新处理？', confirmAcknowledge: '确认已处理？',
      signaturePlaceholder: '—— 由 AI 助手代复',
      bridgeTimeout: '请求超时（90 秒），请重试。', bridgeNetwork: '网络错误：无法连接插件服务。',
      colon: '：',
    };

    // bridge 网络层错误文案：apply 注入 bind 后的 t 之前先用 en 兜底（面板渲染必然晚于 apply）。
    let bridgeText = (key) => en[key] ?? key;

    async function bridge(action, options = {}) {
      const method = options.method ?? (action === 'state' || action === 'models' || action === 'workspaces' ? 'GET' : 'POST');
      const headers = { Accept: 'application/json' };
      if (method === 'POST') headers['Content-Type'] = 'application/json';
      const query = method === 'GET' ? `?action=${encodeURIComponent(action)}` : '';
      let response;
      try {
        response = await fetch(`${BRIDGE_PATH}${query}`, {
          method,
          headers,
          body: method === 'POST' ? JSON.stringify({ action, ...(options.payload ?? {}) }) : undefined,
          // 与 cordis.patch.yml 的 requestTimeoutMs 对齐：poll 等长操作与其他操作统一 90 秒超时。
          signal: AbortSignal.timeout(90000),
        });
      } catch (cause) {
        if (cause && (cause.name === 'TimeoutError' || cause.name === 'AbortError')) throw new Error(bridgeText('bridgeTimeout'));
        throw new Error(bridgeText('bridgeNetwork'));
      }
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

    /** 路由与 dispatch 共用可见性边界，但不接受“MR 直接完成”和规则跳过项。 */
    function canRouteTodo(todo) {
      if (todo.outcome === 'rule-skipped' || String(todo.action ?? '').toLowerCase() === 'assigned') return false;
      if (isMergeRequest(todo) && !todo.directMention) return false;
      return !todo.handled || todo.outcome !== 'merge-request-done';
    }

    function routedLabel(record, t) {
      if (record.routed !== true) return '';
      return record.routeMode === 'steer' ? t('routedSteer') : t('routedQueue');
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

    /** 回复预览：展开显示本轮发到讨论串的我方回复正文（来自插件结算时的捕获快照）。 */
    function ReplyPreview({ reply, t }) {
      const [open, setOpen] = React.useState(false);
      if (!reply || (!reply.body && !reply.url)) return null;
      return h('div', { className: 'gta-reply' },
        h('button', {
          type: 'button', className: 'gta-reply-toggle',
          'aria-expanded': open,
          onClick: () => setOpen(!open),
        }, `${t('replyPreview')} ${open ? '▲' : '▼'}`),
        open && h('div', { className: 'gta-reply-body' },
          reply.url && h('a', { className: 'gta-reply-link', href: reply.url, target: '_blank', rel: 'noreferrer' }, '#'),
          h('div', { className: 'gta-reply-text' }, reply.body || '—'),
        ),
      );
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

    /**
     * 设置字段级比较：原始值直接比对；sessionModel/taskModels 等嵌套对象递归按字段比对，
     * 引用不同但等值不算变更；undefined 与 null 归一后视为相同。
     */
    function settingsValueEqual(next, prev) {
      const a = next === undefined ? null : next;
      const b = prev === undefined ? null : prev;
      if (a === b) return true;
      if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
      const aKeys = Object.keys(a);
      const bKeys = Object.keys(b);
      if (aKeys.length !== bKeys.length) return false;
      return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && settingsValueEqual(a[key], b[key]));
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
      // 按 key 隔离的请求互斥：state 驱动各按钮自己的禁用态，ref 保证同 key 重复触发被同步拒绝。
      const [busyKeys, setBusyKeys] = React.useState([]);
      const busyKeysRef = React.useRef(new Set());
      const busySet = new Set(busyKeys);
      const [error, setError] = React.useState(null);
      // 轮询类错误单独存放：轮询成功即自动清除；操作类错误仍由下一次主动操作清除。
      const [pollError, setPollError] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [activeTab, setActiveTab] = React.useState('todos');
      const [modelCatalog, setModelCatalog] = React.useState(null);
      const [modelCatalogError, setModelCatalogError] = React.useState(null);
      const [workspaceData, setWorkspaceData] = React.useState(null);
      const [workspaceError, setWorkspaceError] = React.useState(null);
      const [routeTodo, setRouteTodo] = React.useState(null);
      const [routeData, setRouteData] = React.useState(null);
      const [routeLoading, setRouteLoading] = React.useState(false);
      const [routeError, setRouteError] = React.useState(null);
      const [routeSearch, setRouteSearch] = React.useState('');
      const [routeSelection, setRouteSelection] = React.useState('');
      const routeRequest = React.useRef(0);

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

      // 收件箱（需人工待办）：打开期间每 10s 刷新；确认动作后立即重拉。
      const [inboxData, setInboxData] = React.useState(null);
      const [inboxError, setInboxError] = React.useState(null);
      const inboxInFlight = React.useRef(false);
      const fetchInbox = async () => {
        if (inboxInFlight.current) return;
        inboxInFlight.current = true;
        try {
          const data = await post('inbox', {});
          setInboxData(Array.isArray(data.items) ? data.items : []);
          setInboxError(null);
        } catch (cause) {
          setInboxError(cause.message);
        } finally {
          inboxInFlight.current = false;
        }
      };
      React.useEffect(() => {
        if (activeTab !== 'inbox') return undefined;
        void fetchInbox();
        const timer = setInterval(() => void fetchInbox(), 10000);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [activeTab]);

      const [digestOpen, setDigestOpen] = React.useState(false);

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
            if (!disposed) {
              setSnapshot(next);
              setPollError(null);
            }
          } catch (cause) {
            if (!disposed) setPollError(cause.message);
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
        if (busyKeysRef.current.has(key)) return false;
        busyKeysRef.current.add(key);
        setBusyKeys([...busyKeysRef.current]);
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
          busyKeysRef.current.delete(key);
          setBusyKeys([...busyKeysRef.current]);
        }
      };

      // 双段确认：不可逆操作第一击只把按钮切到确认文案，3 秒内再次点击才真正执行，超时自动还原。
      // Map<key, timestamp>：每个按钮独立状态；时间戳兜底，即便还原定时器被节流也不放行过期确认。
      const [confirmKeys, setConfirmKeys] = React.useState(new Map());
      const confirmTimers = React.useRef(new Map());
      const clearConfirm = (key) => {
        const timer = confirmTimers.current.get(key);
        if (timer) clearTimeout(timer);
        confirmTimers.current.delete(key);
        setConfirmKeys((prev) => {
          if (!prev.has(key)) return prev;
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
      };
      const guardedRun = (confirmKey, action) => () => {
        const pendingAt = confirmKeys.get(confirmKey);
        if (pendingAt && Date.now() - pendingAt <= 3000) {
          clearConfirm(confirmKey);
          void action();
          return;
        }
        setConfirmKeys((prev) => {
          const next = new Map(prev);
          next.set(confirmKey, Date.now());
          return next;
        });
        clearTimeout(confirmTimers.current.get(confirmKey));
        confirmTimers.current.set(confirmKey, setTimeout(() => clearConfirm(confirmKey), 3000));
      };
      React.useEffect(() => () => {
        confirmTimers.current.forEach((timer) => clearTimeout(timer));
        confirmTimers.current.clear();
      }, []);

      // 模板拼接用冒号：zh 全角“：”，en 半角“: ”，随当前 locale 取词典。
      const colon = () => t('colon');

      const closeRouteTargets = () => {
        routeRequest.current += 1;
        setRouteTodo(null);
        setRouteData(null);
        setRouteLoading(false);
        setRouteError(null);
        setRouteSearch('');
        setRouteSelection('');
      };
      const loadRouteTargets = async (todoId) => {
        const request = ++routeRequest.current;
        setRouteLoading(true);
        setRouteError(null);
        setRouteSelection('');
        try {
          const data = await post('routeTargets', { todoId });
          if (request !== routeRequest.current) return;
          setRouteData({ ...data, items: Array.isArray(data.items) ? data.items : [] });
        } catch (cause) {
          if (request !== routeRequest.current) return;
          setRouteError(cause.message);
        } finally {
          if (request === routeRequest.current) setRouteLoading(false);
        }
      };
      const openRouteTargets = (todo) => {
        setRouteTodo(todo);
        setRouteData(null);
        setRouteSearch('');
        setRouteSelection('');
        setRouteError(null);
        void loadRouteTargets(todo.id);
      };
      React.useEffect(() => {
        if (!routeTodo) return undefined;
        const onKeyDown = (event) => {
          if (event.key === 'Escape') closeRouteTargets();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
        // 关闭函数只需跟随当前弹层生命周期，无需随每次渲染重建监听。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [routeTodo]);
      const routeToSession = (target) => {
        if (!routeTodo || !target || target.accepting === false || busySet.has(`route:${routeTodo.id}`)) return;
        const todoId = routeTodo.id;
        setRouteError(null);
        void perform(`route:${todoId}`, async () => {
          try {
            const data = await post('route', { id: todoId, sessionId: target.sessionId });
            if (data.result?.ok === false) setRouteError(data.result.error || t('routeFailed'));
            return data;
          } catch (cause) {
            setRouteError(cause.message);
            throw cause;
          }
        }).then((done) => {
          if (!done) return;
          closeRouteTargets();
          void refreshSessions();
        });
      };

      const updateSettings = (settings) => perform('settings', () => post('updateSettings', { settings }));
      // 保存时对比当前快照，只提交发生变化的字段（Host 端 updateSettings 为浅合并 patch 语义）：
      // 面板打开期间页头快捷操作（启停轮询、页头模型下拉）已保存的改动不会被打开面板时的旧 draft 覆盖。
      const saveGeneralSettings = () => {
        const current = snapshot?.settings ?? null;
        const patch = {};
        let changed = false;
        Object.keys(draft ?? {}).forEach((key) => {
          if (!settingsValueEqual(draft[key], current ? current[key] : undefined)) {
            patch[key] = draft[key];
            changed = true;
          }
        });
        return changed ? updateSettings(patch) : Promise.resolve(true);
      };
      const openSession = (sessionId) => ctx.uiWorkspace.openSession(sessionId);
      // 收件箱“我已处理”：成功后连同收件箱一起刷新（snapshot 已由 perform 更新）。
      const acknowledgeInboxItem = (item) => perform(`ack:${item.todoId}`, () => post('acknowledge', { todoId: item.todoId }))
        .then((done) => { if (done) void fetchInbox(); });
      // Todo 主按钮（开会话/重新处理）与“标记完成”都走 dispatch：Host 端会把非 directMention 的 MR 直接标记完成。
      const dispatchTodo = (todo) => perform(`dispatch:${todo.id}`, () => post('dispatch', { id: todo.id }));
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
      const allRouteItems = Array.isArray(routeData?.items) ? routeData.items : [];
      const routeQuery = routeSearch.trim().toLowerCase();
      const routeUpdatedAt = (value) => {
        const parsed = typeof value === 'number' ? value : Date.parse(value ?? '');
        return Number.isFinite(parsed) ? parsed : 0;
      };
      const routeItems = allRouteItems
        .filter((item) => !routeQuery || [item.title, item.sessionId, item.cwd]
          .some((value) => String(value ?? '').toLowerCase().includes(routeQuery)))
        .sort((a, b) => Number(b.sameTarget === true) - Number(a.sameTarget === true)
          || routeUpdatedAt(b.updatedAt) - routeUpdatedAt(a.updatedAt));
      const selectedRouteTarget = allRouteItems.find((item) => item.sessionId === routeSelection) ?? null;
      const routeMaxQueue = routeData?.maxQueuePerSession ?? 3;

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
                disabled: !snapshot || busySet.has('settings'),
                'aria-label': t('sessionModel'),
                onChange: (event) => updateSettings({ sessionModel: event.target.value ? JSON.parse(event.target.value) : null }),
              }, modelOptions(settings?.sessionModel)),
            ),
            h(Button, {
              primary: !settings?.enabled,
              disabled: busySet.has('settings') || !snapshot,
              onClick: () => updateSettings({ enabled: !settings.enabled }),
            }, settings?.enabled ? t('disable') : t('enable')),
            h(Button, {
              disabled: busySet.has('poll') || !snapshot,
              onClick: () => perform('poll', () => post('poll')),
            }, busySet.has('poll') ? t('checking') : t('checkNow')),
            h(Button, {
              disabled: !snapshot,
              onClick: () => setDraft(draft ? null : { ...settings }),
            }, draft ? t('close') : t('settings')),
          ),
        ),
        h('p', { className: 'gta-muted gta-paused' }, t('defaultPaused')),
        !snapshot && !error && h('div', { className: 'gta-empty' }, t('loading')),
        (error || pollError) && h('div', { className: 'gta-banner gta-error', role: 'alert' }, `${t('localError')}${colon()}${error || pollError}`),
        snapshot?.lastPollError && h('div', { className: 'gta-banner gta-error', role: 'alert' }, snapshot.lastPollError),
        snapshot?.lastDispatchError && h('div', { className: 'gta-banner gta-warn', role: 'status' }, snapshot.lastDispatchError),
        snapshot?.lastPrecheckError && h('div', { className: 'gta-banner gta-warn', role: 'status' }, snapshot.lastPrecheckError),
        modelCatalogError && h('div', { className: 'gta-banner gta-warn', role: 'status' }, `${t('modelCatalogError')}${colon()}${modelCatalogError}`),
        snapshot?.digest && h('section', { className: 'gta-card gta-digest' },
          h('div', { className: 'gta-digest-head' },
            h('h2', null, `${t('digestTitle')}（${snapshot.digest.counts.total}）`),
            h('span', { className: 'gta-muted' },
              `${t('closureClosed')} ${snapshot.digest.counts.closed} · ${t('closureFollowUp')} ${snapshot.digest.counts.followUp} · ${t('closureNeedsHuman')} ${snapshot.digest.counts.needsHuman} · ${t('needsHumanCount')} ${snapshot.digest.open.needsHuman}`),
            h(Button, { onClick: () => setDigestOpen(!digestOpen) }, digestOpen ? t('digestHide') : t('digestShow')),
          ),
          digestOpen && (snapshot.digest.items.length === 0
            ? h('div', { className: 'gta-muted' }, t('digestEmpty'))
            : h('ul', { className: 'gta-digest-list' }, snapshot.digest.items.map((item) => h('li', { key: item.todoId },
              item.url
                ? h('a', { href: item.url, target: '_blank', rel: 'noreferrer' }, item.title || `Todo ${item.todoId}`)
                : h('span', null, item.title || `Todo ${item.todoId}`),
              h('span', { className: 'gta-tag' }, closureLabel(item.closure, t) || item.closure || '—'),
              item.taskType && h('span', { className: 'gta-muted' }, item.taskType),
              item.round > 1 && h('span', { className: 'gta-muted' }, `${t('roundLabel')} ${item.round}`),
              item.closureNote && h('span', { className: 'gta-muted gta-digest-note' }, item.closureNote),
              item.replyExcerpt && h('span', { className: 'gta-muted gta-digest-reply' },
                `${t('replyPreview')}${colon()}`,
                item.replyUrl
                  ? h('a', { href: item.replyUrl, target: '_blank', rel: 'noreferrer' }, item.replyExcerpt)
                  : item.replyExcerpt),
            )))),
        ),
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
            h('label', null, t('routeScope'), h('select', {
              value: draft.routeScope ?? 'plugin',
              onChange: (event) => setDraft({ ...draft, routeScope: event.target.value }),
            },
              h('option', { value: 'plugin' }, t('routeScopePlugin')),
              h('option', { value: 'any' }, t('routeScopeAny')),
            )),
            h('label', null, t('busyRouteMode'), h('select', {
              value: draft.busyRouteMode ?? 'queue',
              onChange: (event) => setDraft({ ...draft, busyRouteMode: event.target.value }),
            },
              h('option', { value: 'queue' }, t('busyRouteQueue')),
              h('option', { value: 'steer' }, t('busyRouteSteer')),
            )),
            h('label', null, t('maxQueuePerSession'), h('input', {
              type: 'number', min: 1, max: 10, value: draft.maxQueuePerSession ?? 3,
              onChange: (event) => setDraft({ ...draft, maxQueuePerSession: Number(event.target.value) }),
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
            ...['question', 'review', 'change'].map((type) => h('label', { key: type },
              t(type === 'question' ? 'taskModelQuestion' : type === 'review' ? 'taskModelReview' : 'taskModelChange'),
              h('select', {
                value: sessionModelKey(draft.taskModels?.[type]),
                onChange: (event) => setDraft({
                  ...draft,
                  taskModels: { ...(draft.taskModels ?? {}), [type]: event.target.value ? JSON.parse(event.target.value) : null },
                }),
              }, modelOptions(draft.taskModels?.[type], t('taskModelDefault'))))),
            h('p', { className: 'gta-muted gta-wide' }, t('sessionModelFixedHint')),
            h('p', { className: 'gta-muted gta-wide' }, t('judgeModelHint')),
            h('p', { className: 'gta-muted gta-wide' }, t('taskModelsHint')),
            h('label', { className: 'gta-wide' }, t('sessionCwd'), h('select', {
              value: draft.sessionCwd,
              onChange: (event) => setDraft({ ...draft, sessionCwd: event.target.value }),
            },
              h('option', { value: '' }, t('sessionCwdAuto')),
              draftSessionCwdUnregistered && h('option', { value: draft.sessionCwd }, `${t('sessionCwdUnregistered')}${colon()}${draft.sessionCwd}`),
              workspaceOptions.map((workspace) => h('option', { key: workspace.workspaceId, value: workspace.path },
                `${workspace.title || workspace.path} · ${workspace.path}`)),
            ), h('span', { className: 'gta-muted' }, t('sessionCwdHint'))),
            h('label', { className: 'gta-wide' }, t('cwd'), h('input', {
              type: 'text', value: draft.cwd, placeholder: t('cwdHint'),
              onChange: (event) => setDraft({ ...draft, cwd: event.target.value }),
            })),
            h('label', { className: 'gta-wide' }, t('customRules'), h('textarea', {
              className: 'gta-rules', rows: 4, maxLength: 4000, value: draft.customRules ?? '',
              onChange: (event) => setDraft({ ...draft, customRules: event.target.value }),
            }), h('span', { className: 'gta-muted' }, t('customRulesHint'))),
            h('label', { className: 'gta-wide' }, t('signatureText'), h('input', {
              type: 'text', maxLength: 100, value: draft.signatureText ?? '',
              disabled: draft.replySignature !== true, placeholder: t('signaturePlaceholder'),
              onChange: (event) => setDraft({ ...draft, signatureText: event.target.value }),
            }), h('span', { className: 'gta-muted' }, t('signatureHint'))),
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
            type: 'checkbox', checked: draft.autoRoute !== false,
            onChange: (event) => setDraft({ ...draft, autoRoute: event.target.checked }),
          }), t('autoRoute')),
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
          h('label', { className: 'gta-check' }, h('input', {
            type: 'checkbox', checked: draft.waitProbeEnabled !== false, disabled: draft.followUpEnabled === false,
            onChange: (event) => setDraft({ ...draft, waitProbeEnabled: event.target.checked }),
          }), t('waitProbeEnabled')),
          h('label', { className: 'gta-check' }, h('input', {
            type: 'checkbox', checked: draft.followUpReuseSession !== false, disabled: draft.followUpEnabled === false,
            onChange: (event) => setDraft({ ...draft, followUpReuseSession: event.target.checked }),
          }), t('followUpReuseSession')),
          h('label', { className: 'gta-check' }, h('input', {
            type: 'checkbox', checked: draft.replySignature === true,
            onChange: (event) => setDraft({ ...draft, replySignature: event.target.checked }),
          }), t('signatureLabel')),
          h('div', { className: 'gta-form-actions' },
            h(Button, { primary: true, disabled: busySet.has('settings'), onClick: () => saveGeneralSettings().then((saved) => { if (saved) setDraft(null); }) }, t('save')),
            h(Button, { onClick: () => setDraft(null) }, t('cancel')),
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
            type: 'button', role: 'tab', id: `${PANEL_ID}-tab-inbox`, 'aria-selected': activeTab === 'inbox',
            'aria-controls': `${PANEL_ID}-panel-inbox`,
            className: `gta-tab${activeTab === 'inbox' ? ' gta-tab-active' : ''}`,
            onClick: () => setActiveTab('inbox'),
          }, `${t('inboxTitle')} (${snapshot.closure?.needsHuman ?? 0})`),
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
        activeTab === 'inbox' && snapshot && h('section', { className: 'gta-section', role: 'tabpanel', id: `${PANEL_ID}-panel-inbox`, 'aria-labelledby': `${PANEL_ID}-tab-inbox` },
          h('div', { className: 'gta-section-title' }, h('h2', null, t('inboxTitle')), h('span', { className: 'gta-muted' }, `${snapshot.closure?.needsHuman ?? 0}`)),
          inboxError && h('div', { className: 'gta-banner gta-warn', role: 'status' }, `${t('inboxError')}${colon()}${inboxError}`),
          !inboxData && !inboxError && h('div', { className: 'gta-empty' }, t('loading')),
          inboxData && inboxData.length === 0 && h('div', { className: 'gta-empty' }, t('inboxEmpty')),
          inboxData && inboxData.length > 0 && h('div', { className: 'gta-list gta-scroll-list', role: 'list', 'aria-label': t('inboxTitle') },
            inboxData.map((item) => h('article', { className: 'gta-todo', key: item.todoId },
              h('div', { className: 'gta-todo-main' },
                h('div', { className: 'gta-todo-title' },
                  item.url
                    ? h('a', { href: item.url, target: '_blank', rel: 'noreferrer' }, item.title)
                    : h('span', null, item.title),
                  h('span', { className: 'gta-tag' }, t('closureNeedsHuman')),
                  item.pendingUnconfirmed && h('span', { className: 'gta-tag' }, t('inboxPendingUnconfirmed')),
                  item.routed && routedLabel(item, t) && h('span', { className: 'gta-tag gta-tag-routed' }, routedLabel(item, t)),
                ),
                h('div', { className: 'gta-muted gta-meta' },
                  [item.closureNote, item.project, item.sessionTitle, item.round > 1 && `${t('roundLabel')} ${item.round}`,
                    item.completedAt && formatTime(item.completedAt, '')].filter(Boolean).join(' · ')),
                h(ReplyPreview, { reply: item.lastReply, t }),
              ),
              h('div', { className: 'gta-todo-actions' },
                item.sessionId && h(Button, { onClick: () => openSession(item.sessionId) }, t('inboxTakeover')),
                h(Button, {
                  primary: true,
                  disabled: busySet.has(`ack:${item.todoId}`),
                  onClick: guardedRun(`ack:${item.todoId}`, () => { void acknowledgeInboxItem(item); }),
                }, busySet.has(`ack:${item.todoId}`) ? '…'
                  : confirmKeys.has(`ack:${item.todoId}`) ? t('confirmAcknowledge') : t('inboxAcknowledge')),
              ),
            ))),
        ),
        activeTab === 'todos' && snapshot && h('section', { className: 'gta-section', role: 'tabpanel', id: `${PANEL_ID}-panel-todos`, 'aria-labelledby': `${PANEL_ID}-tab-todos` },
          h('div', { className: 'gta-section-title' }, h('h2', null, t('todoList')), h('span', { className: 'gta-muted' }, `${t('newFound')}${colon()}${snapshot.lastNewCount}`)),
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
                      routedLabel(todo, t) && h('span', { className: 'gta-tag gta-tag-routed' }, routedLabel(todo, t)),
                    ),
                    h('div', { className: 'gta-muted gta-meta' }, [`#${todo.id}`, todo.project, todo.targetType, todo.action, todo.author && `@${todo.author}`, todo.skipReason, ...closureMeta(todo, t)].filter(Boolean).join(' · ')),
                    h(ReplyPreview, { reply: todo.lastReply, t }),
                  ),
                  h('div', { className: 'gta-todo-actions' },
                    todo.sessionId && h(Button, { onClick: () => openSession(todo.sessionId) }, t('openSession')),
                    // 主按钮只负责开会话：未处理开新会话；已处理为“重新处理”（不可逆，需二次确认）。
                    (!todo.handled || todo.outcome !== 'merge-request-done') && h(Button, {
                      primary: !todo.handled,
                      disabled: busySet.has(`dispatch:${todo.id}`) || todo.executionStatus === 'running',
                      onClick: todo.handled
                        ? guardedRun(`reprocess:${todo.id}`, () => { void dispatchTodo(todo); })
                        : () => { void dispatchTodo(todo); },
                    }, busySet.has(`dispatch:${todo.id}`) ? '…'
                      : todo.handled && confirmKeys.has(`reprocess:${todo.id}`) ? t('confirmReprocess')
                      : todo.handled ? t('reprocess') : t('process')),
                    // “标记完成”独立为次级按钮（沿用原显示条件：非 directMention 的 MR），
                    // 不再与开会话共用按钮；同样不可逆，需二次确认。
                    !todo.handled && isMergeRequest(todo) && !todo.directMention && h(Button, {
                      disabled: busySet.has(`dispatch:${todo.id}`) || todo.executionStatus === 'running',
                      onClick: guardedRun(`markdone:${todo.id}`, () => { void dispatchTodo(todo); }),
                    }, busySet.has(`dispatch:${todo.id}`) ? '…'
                      : confirmKeys.has(`markdone:${todo.id}`) ? t('confirmMarkDone') : t('markDone')),
                    canRouteTodo(todo) && h(Button, {
                      disabled: todo.executionStatus === 'running',
                      onClick: () => openRouteTargets(todo),
                    }, t('routeToSession')),
                  ),
                ),
              )),
        ),
        activeTab === 'sessions' && snapshot && h('section', { className: 'gta-section', role: 'tabpanel', id: `${PANEL_ID}-panel-sessions`, 'aria-labelledby': `${PANEL_ID}-tab-sessions` },
          h('div', { className: 'gta-section-title' }, h('h2', null, t('sessionsTitle')), h('span', { className: 'gta-muted' },
            sessionData ? `${sessionData.items.length}/${sessionData.total}` : `${(snapshot.sessions ?? []).length}`)),
          sessionError && h('div', { className: 'gta-banner gta-warn', role: 'status' }, `${t('sessionsError')}${colon()}${sessionError}`),
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
                      routedLabel(record, t) && h('span', { className: 'gta-tag gta-tag-routed' }, routedLabel(record, t)),
                      closureLabel(record.closure, t) && h('span', { className: `gta-tag ${record.closure === 'closed' ? 'gta-tag-success' : ''}` }, closureLabel(record.closure, t)),
                      h('span', { className: 'gta-tag gta-tag-mention' }, record.automatic ? t('autoDispatch') : t('manualDispatch')),
                      record.archived && h('span', { className: 'gta-tag gta-tag-success' }, t('sessionArchived')),
                    ),
                    h('div', { className: 'gta-muted gta-meta' },
                      [record.sessionTitle, record.project, record.executionError, ...closureMeta(record, t), record.archiveError].filter(Boolean).join(' · ')),
                    h(ReplyPreview, { reply: record.lastReply, t }),
                  ),
                  h('div', { className: 'gta-todo-actions' },
                    !record.archived && h(Button, { onClick: () => openSession(record.sessionId) }, t('openSession')),
                    record.executionStatus !== 'starting' && record.routed !== true && h(Button, {
                      disabled: busySet.has(`archive:${record.sessionId}`) || (record.archived !== true && record.executionStatus === 'running'),
                      onClick: () => toggleSessionArchive(record),
                    }, busySet.has(`archive:${record.sessionId}`) ? '…' : (record.archived ? t('unarchiveSession') : t('archiveSession'))),
                  ),
                ),
              )),
          sessionData && sessionData.items.length < sessionData.total && h('div', { className: 'gta-load-more' },
            h(Button, { disabled: Boolean(sessionBusy), onClick: () => fetchSessions(true) }, sessionBusy ? '…' : t('loadMore'))),
        ),
        activeTab === 'workspaces' && h('section', { className: 'gta-section', role: 'tabpanel', id: `${PANEL_ID}-panel-workspaces`, 'aria-labelledby': `${PANEL_ID}-tab-workspaces` },
          h('div', { className: 'gta-section-title' }, h('h2', null, t('workspacesTitle')), h('span', { className: 'gta-muted' }, `${workspaceOptions.length}`)),
          workspaceError && h('div', { className: 'gta-banner gta-warn', role: 'status' }, `${t('workspacesError')}${colon()}${workspaceError}`),
          workspaceOptions.length === 0 && !workspaceError && h('div', { className: 'gta-empty' }, t('noWorkspaces')),
          h('div', { className: 'gta-list gta-scroll-list', role: 'list', 'aria-label': t('workspacesTitle') },
            workspaceOptions.map((workspace) =>
              h('article', { className: 'gta-todo gta-workspace', key: workspace.workspaceId || 'unassigned' },
                h('div', { className: 'gta-todo-main' },
                  h('div', { className: 'gta-todo-title' },
                    h('span', { className: 'gta-workspace-name', title: workspace.path },
                      workspace.unassigned ? t('unassignedWorkspace') : workspace.title || workspace.path || workspace.workspaceId),
                    workspace.configured && h('span', { className: 'gta-tag gta-tag-mention' }, t('configuredWorkspace')),
                    h('span', { className: 'gta-muted' }, `${t('sessionsTitle')}${colon()}${workspace.sessionCount}`),
                  ),
                  h('div', { className: 'gta-muted gta-meta' },
                    [workspace.path, workspace.updatedAt ? `${t('lastActive')}${colon()}${formatTime(workspace.updatedAt, '')}` : ''].filter(Boolean).join(' · ')),
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
        routeTodo && h('div', {
          className: 'gta-route-backdrop',
          onMouseDown: (event) => { if (event.target === event.currentTarget) closeRouteTargets(); },
        },
          h('section', {
            className: 'gta-route-dialog', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'gta-route-title',
          },
            h('div', { className: 'gta-route-header' },
              h('div', { className: 'gta-route-heading' },
                h('h2', { id: 'gta-route-title' }, t('routeToSession')),
                h('p', { className: 'gta-muted gta-route-todo', title: routeTodo.title }, routeTodo.title),
              ),
              h(Button, { onClick: closeRouteTargets }, t('close')),
            ),
            routeData && h('div', { className: 'gta-route-summary gta-muted' },
              h('span', null, `${t('routeScope')}${colon()}${routeData.scope === 'any' ? t('routeScopeAny') : t('routeScopePlugin')}`),
              h('span', null, `${t('busyRouteMode')}${colon()}${routeData.busyRouteMode === 'steer' ? t('busyRouteSteer') : t('busyRouteQueue')}`),
              h('span', null, `${t('maxQueuePerSession')}${colon()}${routeMaxQueue}`),
            ),
            routeError && h('div', { className: 'gta-banner gta-error gta-route-error', role: 'alert' }, `${t('localError')}${colon()}${routeError}`),
            h('div', { className: 'gta-route-tools' },
              h('input', {
                type: 'text', value: routeSearch, placeholder: t('routeSearch'), 'aria-label': t('routeSearch'),
                disabled: !routeData || routeLoading,
                onChange: (event) => setRouteSearch(event.target.value),
              }),
              h(Button, {
                disabled: routeLoading || busySet.has(`route:${routeTodo.id}`),
                onClick: () => loadRouteTargets(routeTodo.id),
              }, routeLoading ? '…' : t('refresh')),
            ),
            routeLoading && !routeData && h('div', { className: 'gta-empty' }, t('routeLoading')),
            routeData && !routeLoading && allRouteItems.length === 0 && h('div', { className: 'gta-empty' }, t('routeEmpty')),
            routeData && !routeLoading && allRouteItems.length > 0 && routeItems.length === 0 && h('div', { className: 'gta-empty' }, t('routeNoMatches')),
            routeData && routeItems.length > 0 && h('div', { className: 'gta-route-targets', role: 'listbox', 'aria-label': t('routeToSession') },
              routeItems.map((item) => h('button', {
                type: 'button', role: 'option', key: item.sessionId,
                className: `gta-route-target${routeSelection === item.sessionId ? ' gta-route-target-selected' : ''}`,
                'aria-selected': routeSelection === item.sessionId,
                disabled: item.accepting === false || busySet.has(`route:${routeTodo.id}`),
                onClick: () => setRouteSelection(item.sessionId),
              },
                h('div', { className: 'gta-route-target-main' },
                  h('div', { className: 'gta-route-target-title' },
                    h('span', { className: 'gta-route-target-name', title: item.title }, item.title || t('sessionUnknown')),
                    item.sameTarget === true && h('span', { className: 'gta-tag gta-tag-mention' }, t('routeSameTarget')),
                    item.plugin === true && h('span', { className: 'gta-tag gta-tag-mention' }, t('pluginSessionTag')),
                    item.running === true && h('span', { className: 'gta-tag' }, t('executionRunning')),
                    item.running === true && h('span', { className: 'gta-tag gta-tag-routed' },
                      routeData.busyRouteMode === 'steer' ? t('routeModeSteer') : t('routeModeQueue')),
                    item.accepting === false && h('span', { className: 'gta-tag' }, t('routeNotAccepting')),
                  ),
                  h('div', { className: 'gta-muted gta-route-target-meta' },
                    [item.sessionId, item.cwd, item.updatedAt ? `${t('lastActive')}${colon()}${formatTime(item.updatedAt, '')}` : ''].filter(Boolean).join(' · ')),
                ),
                h('span', { className: 'gta-route-load', title: t('maxQueuePerSession') }, `${t('routeLoad')} ${item.load ?? 0}/${routeMaxQueue}`),
              ))),
            h('div', { className: 'gta-route-footer' },
              h(Button, {
                primary: true,
                disabled: !selectedRouteTarget || selectedRouteTarget.accepting === false || routeLoading || busySet.has(`route:${routeTodo.id}`),
                onClick: () => routeToSession(selectedRouteTarget),
              }, busySet.has(`route:${routeTodo.id}`) ? '…' : t('routeConfirm')),
            ),
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
      .gta-root input[type=text],.gta-root input[type=number],.gta-root select,.gta-root textarea{width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;padding:8px 10px}.gta-root textarea{resize:vertical;line-height:1.5}.gta-check{display:flex;align-items:center;gap:8px;margin:16px 0 0}.gta-form-actions{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
      .gta-stats{display:grid;grid-template-columns:repeat(4,minmax(100px,1fr));gap:10px}.gta-stat{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;display:flex;flex-direction:column;gap:4px}.gta-stat>span{color:var(--dsw-alias-label-secondary);font-size:12px}.gta-stat>strong{font-size:18px}.gta-stat-time{grid-column:span 2}.gta-stat-time>strong{font-size:13px}
      .gta-section-title{display:flex;align-items:baseline;justify-content:space-between;gap:16px}.gta-tabs{max-width:1180px;margin:16px auto 0;display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1)}.gta-tab{appearance:none;margin-bottom:-1px;padding:9px 18px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;white-space:nowrap}.gta-tab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}.gta-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.gta-tab-active{border-bottom-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:600}.gta-list{display:flex;flex-direction:column;gap:8px}.gta-load-more{display:flex;justify-content:center;padding:10px 0 2px}.gta-scroll-list{max-height:min(52vh,480px);overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-gutter:stable;padding:2px 6px 2px 2px}.gta-scroll-list::-webkit-scrollbar{width:8px}.gta-scroll-list::-webkit-scrollbar-track{background:transparent}.gta-scroll-list::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:4px}.gta-scroll-list::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-label-tertiary,var(--dsw-alias-border-l2))}.gta-todo{display:flex;align-items:center;gap:16px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}.gta-todo-main{min-width:0;flex:1}.gta-todo-title{display:flex;align-items:center;gap:10px;font-weight:550}.gta-todo-title>a{color:var(--dsw-alias-label-primary);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gta-todo-title>a:hover{color:var(--dsw-alias-brand-primary);text-decoration:underline}.gta-tag{flex:none;font-size:11px;padding:1px 7px;border-radius:10px;color:var(--dsw-alias-state-warn-primary);border:1px solid var(--dsw-alias-state-warn-primary)}.gta-tag-success{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}.gta-tag-mention{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}.gta-meta{margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gta-todo-actions{display:flex;gap:8px;flex:none}.gta-session-list{max-height:min(40vh,360px)}
      .gta-workspace{flex-direction:column;align-items:stretch;gap:10px}.gta-workspace-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gta-workspace-sessions{display:flex;flex-direction:column;gap:6px;margin-top:4px}.gta-workspace-session{display:flex;align-items:center;gap:10px;padding:7px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);min-width:0}.gta-session-link{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-weight:550;padding:0;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto;min-width:0}.gta-session-link:hover{color:var(--dsw-alias-brand-primary);text-decoration:underline}.gta-session-name{font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:0 1 auto;min-width:0}.gta-session-meta{margin-left:auto;flex:none}
      .gta-empty{padding:24px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;text-align:center;color:var(--dsw-alias-label-secondary)}.gta-fatal{max-width:720px;margin:48px auto;padding:24px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}.gta-fatal p{white-space:pre-wrap;word-break:break-word;margin:12px 0 20px;color:var(--dsw-alias-state-error-primary)}
      .gta-root .gta-tag-routed{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
      .gta-root .gta-route-backdrop{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgb(0 0 0 / .38)}
      .gta-root .gta-route-dialog{display:flex;flex-direction:column;width:min(760px,100%);max-height:min(78vh,760px);overflow:hidden;padding:18px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 18px 60px rgb(0 0 0 / .25)}
      .gta-root .gta-route-header{display:flex;align-items:flex-start;gap:16px;flex:none}.gta-root .gta-route-heading{min-width:0;flex:1}.gta-root .gta-route-heading h2{margin:0}.gta-root .gta-route-todo{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .gta-root .gta-route-summary{display:flex;gap:6px 16px;flex-wrap:wrap;flex:none;margin-top:12px}.gta-root .gta-route-error{max-width:none;margin:10px 0;flex:none}
      .gta-root .gta-route-tools{display:flex;align-items:center;gap:8px;flex:none;margin:14px 0 10px}.gta-root .gta-route-tools input{flex:1;min-width:0}.gta-root .gta-route-dialog>.gta-empty{flex:none}
      .gta-root .gta-route-targets{display:flex;flex:1 1 auto;flex-direction:column;gap:8px;min-height:80px;overflow-y:auto;overscroll-behavior:contain;padding:2px;scrollbar-width:thin}
      .gta-root .gta-route-target{appearance:none;width:100%;display:flex;align-items:center;gap:12px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}.gta-root .gta-route-target:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}.gta-root .gta-route-target:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.gta-root .gta-route-target:disabled{opacity:.5;cursor:default}.gta-root .gta-route-target-selected:not(:disabled){border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
      .gta-root .gta-route-target-main{min-width:0;flex:1}.gta-root .gta-route-target-title{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-weight:550}.gta-root .gta-route-target-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gta-root .gta-route-target-meta{margin-top:5px;word-break:break-all}.gta-root .gta-route-load{flex:none;margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}
      .gta-root .gta-route-footer{display:flex;justify-content:flex-end;gap:8px;flex:none;padding-top:14px}
      .gta-reply{margin-top:8px}.gta-reply-toggle{appearance:none;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;padding:0;cursor:pointer}.gta-reply-toggle:hover{text-decoration:underline}.gta-reply-body{margin-top:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:12.5px}.gta-reply-link{color:var(--dsw-alias-brand-primary);text-decoration:none;margin-right:6px}
      .gta-digest-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.gta-digest-head h2{margin:0}.gta-digest-list{list-style:none;margin:12px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}.gta-digest-list li{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px}.gta-digest-list a{color:var(--dsw-alias-label-primary);text-decoration:none}.gta-digest-list a:hover{color:var(--dsw-alias-brand-primary)}.gta-digest-note,.gta-digest-reply{flex-basis:100%}
      @media(max-width:640px){.gta-root .gta-route-backdrop{padding:12px}.gta-root .gta-route-dialog{padding:14px}.gta-root .gta-route-target{align-items:flex-start;flex-direction:column}.gta-root .gta-route-load{margin-left:0}}
      @media(max-width:900px){.gta-root{padding:20px 18px 36px}.gta-header{flex-direction:column}.gta-actions{justify-content:flex-start}.gta-form-grid{grid-template-columns:1fr}.gta-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.gta-scroll-list{max-height:min(60vh,420px)}.gta-todo{align-items:flex-start;flex-direction:column}.gta-todo-actions{width:100%;justify-content:flex-end}}
    `;

    return {
      inject: ['slots', 'locale', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'gitlab-todo-agent: locale');
        const t = ctx.locale.bind(NS);
        // bridge 抛错早于任何组件渲染，注入 bind 后的 t 让超时/网络错误文案跟随当前 locale。
        bridgeText = t;
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
