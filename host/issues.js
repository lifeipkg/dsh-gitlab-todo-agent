import { buildIssueProjection } from '../core.js';
import { errorMessage } from './util.js';

/**
 * Issue 面板动作：刷新“指派给我的开放 Issue”列表（写入 state.issues 缓存）、
 * 返回与处理记录合并后的面板投影。拉取不进定时轮询，只由面板主动触发。
 * 挂到 GitlabTodoRuntime 原型上，this 指向运行时实例。
 */
export const issuesMethods = {

  /**
   * 从 GitLab 拉取最新 Issue 列表并持久化。
   * refresh 是显式动作（打开 Tab、点刷新）：失败时抛错给面板，但保留旧缓存可读。
   */
  async refreshIssues() {
    const items = await this.fetchIssues();
    this.state.issues = items;
    this.state.lastIssuesAt = Date.now();
    await this.persistQuietly('Issue 列表');
    return this.issueProjection();
  },

  /** 面板投影：缓存的 Issue 列表 + handled/pending 关联状态 + 已从列表消失的孤儿记录。 */
  issueProjection() {
    try {
      return buildIssueProjection(this.state);
    } catch (error) {
      this.ctx.logger?.warn?.(`[gitlab-todo-agent] Issue 投影构建失败：${errorMessage(error)}`);
      return { items: [], orphans: [] };
    }
  },
};
