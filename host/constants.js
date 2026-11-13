/**
 * 运行时调参常量集中地：轮询、预检、并发、续办、桥接等全部魔法数字。
 * 拆模块时统一集中到这里，避免同一常量被多个模块各自重复定义。
 */

export const TODO_PAGE_SIZE = 100;
export const MAX_TODO_PAGES = 20;
/** Issue 面板“指派给我的开放 Issue”最多翻页数（每页 100，覆盖 300 条）。 */
export const MAX_ISSUE_PAGES = 3;
export const MAX_RULE_SKIPS_PER_POLL = 20;
export const PRECHECK_CONCURRENCY = 3;
/** 同一 Todo 预检连续失败这么多轮后降级为直接派发（此前每轮都会跳过）。 */
export const PRECHECK_MAX_SKIPS = 2;
/** 等待探测：连续这么多次“无变化而推迟”后放行一次心跳续办会话。 */
export const WAIT_PROBE_MAX_DEFERS = 4;
/** 同一会话最多被后续轮次接力复用的次数（含首轮共 1+N 个回合），避免上下文无限增长。 */
export const MAX_SESSION_REUSE = 2;
/** 规则即可判定无需处理的类别 → 标记理由（零模型调用）。 */
export const RULE_SKIP_REASONS = {
  'pipeline-notify': '流水线通知，规则判定无需处理',
  'self-mention': '自己 @ 自己，规则判定无需处理',
  'description-mention': '正文 @ 提及（非评论），规则判定无需处理',
  'assignment-notify': '指派通知（Issue/MR 被指派给我），规则判定无需处理',
};
/** 核对“讨论串里有没有我方回复”时最多翻的 discussions 页数（每页 100）。 */
export const MAX_DISCUSSION_PAGES = 10;
/** 自首轮派发起超过这个时长的链路不再自动续办，避免升级或长期遗留记录触发续办风暴。 */
export const FOLLOW_UP_MAX_AGE_MS = 72 * 60 * 60 * 1000;
/** 续办会话创建失败后的重试间隔（随失败次数指数退避）。 */
export const FOLLOW_UP_RETRY_MS = 5 * 60 * 1000;
/** 续办派发连续失败这么多次后升级需人工，不再无限重试。 */
export const FOLLOW_UP_MAX_DISPATCH_FAILURES = 5;
/** 会话空闲且没有回合结束记录，连续这么多次核对后按“被中断”结算（默认约 2 分钟）。 */
export const IDLE_SETTLE_POLLS = 40;
/** 提示词里告诉会话的 CI 等待预算。 */
export const WAIT_BUDGET_MINUTES = 20;
export const BRIDGE_PATH = '/api/gitlab-todo-agent';
export const MAX_REQUEST_BYTES = 128 * 1024;
