/**
 * 运行时内存日志域：Log Tab 的投影与清空动作。
 * 缓冲在构造器建好（createLogBuffer），业务只写 this.logger.<level>()；
 * 这里只负责把缓冲读成 bridge 形状，不写文件。
 */
import { LOG_MAX_CHARS, LOG_MAX_ENTRIES } from './constants.js';

export const logsMethods = {

  /** Log Tab 投影：新→旧条目 + 丢弃计数 + 容量（面板显示内存上限说明）。 */
  logProjection(limit = 200) {
    const logs = this.logs;
    if (!logs) return { items: [], dropped: 0, total: 0, capacity: { maxEntries: LOG_MAX_ENTRIES, maxChars: LOG_MAX_CHARS } };
    const items = logs.list(limit);
    return {
      items,
      dropped: logs.dropped,
      total: logs.size + logs.dropped,
      capacity: { maxEntries: LOG_MAX_ENTRIES, maxChars: LOG_MAX_CHARS },
    };
  },

  /** 面板「清空」：清空缓冲并留一条审计行（新日志证明清空已生效、谁在什么时候清的）。 */
  clearLogEntries() {
    if (!this.logs) return;
    this.logs.reset();
    // 审计行写在清空之后：它成为新缓冲的第一条，确认清空操作本身已被记录。
    this.logger.info('日志面板执行了清空。');
  },
};
