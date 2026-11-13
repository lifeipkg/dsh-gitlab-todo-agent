import {
  buildBatchJudgePrompt,
  buildJudgePrompt,
  parseBatchJudgeReply,
  parseJudgeReply,
  targetKey,
} from '../core.js';
import { PRECHECK_CONCURRENCY, PRECHECK_MAX_SKIPS } from './constants.js';
import { errorMessage, mapLimit } from './util.js';

/** 兼容多种 llm 流分片形态，取出文本增量。 */
function chunkText(chunk) {
  if (typeof chunk === 'string') return chunk;
  const candidates = [
    chunk?.text, chunk?.delta?.text, chunk?.textDelta, chunk?.content,
    typeof chunk?.delta === 'string' ? chunk.delta : null,
    chunk?.choices?.[0]?.delta?.content,
  ];
  for (const piece of candidates) if (typeof piece === 'string') return piece;
  return '';
}

function judgeOutputError(text) {
  const sample = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return sample ? `预检模型输出无法解析：${sample}` : '预检模型没有返回任何文本。';
}

/** 序列化分片对象成 ≤200 字 JSON 预览，供诊断日志用。 */
function safeJsonPreview(value) {
  try { return JSON.stringify(value).slice(0, 200); }
  catch { return String(value).slice(0, 200); }
}

/**
 * LLM 预检：开会话前的轻量判定（单条 + 批量 + 失败降级）。
 * 挂到 GitlabTodoRuntime 原型上，this 指向运行时实例。
 */
export const precheckMethods = {

  llmRuntime() {
    let llm = null;
    if (typeof this.ctx.get === 'function') {
      try {
        llm = this.ctx.get('llm') ?? null;
      } catch {
        llm = null;
      }
    }
    if (!llm) {
      try {
        llm = this.ctx.llm ?? null;
      } catch {
        llm = null;
      }
    }
    return llm && typeof llm.stream === 'function' ? llm : null;
  },

  async judgeModel() {
    // 预检可用更快的专用小模型；未配置时退回会话模型，再退回 Host 默认模型。
    if (this.state.settings.judgeModel) return this.state.settings.judgeModel;
    if (this.state.settings.sessionModel) return this.state.settings.sessionModel;
    if (!this.catalogCache) {
      try {
        this.catalogCache = await this.host.modelCatalog();
      } catch {
        this.catalogCache = null;
      }
    }
    const fallback = this.catalogCache?.default;
    return fallback?.provider && fallback?.model ? { provider: fallback.provider, model: fallback.model } : null;
  },

  /**
   * 开会话前的轻量预判：不需要处理的提及直接标记 Todo 完成。
   * 任何失败（无 llm 服务、路由不可用、超时、解析失败）返回 null：调用方让该 Todo
   * 本轮跳过（不标记、不开会话），留待下一轮重试——对代发账号，误开会话公开回复
   * 比晚一轮处理更难收回。
   */
  async judgeNeedsProcessing(todo) {
    const llm = this.llmRuntime();
    if (!llm) {
      this.lastJudgeError = '宿主未提供 llm 服务，预检不可用。';
      return null;
    }
    const route = await this.judgeModel();
    if (!route) {
      this.lastJudgeError = '没有可用的预检模型（未配置预检/Session 模型，也读不到宿主默认模型）。';
      return null;
    }
    const timeoutMs = Number.isFinite(this.config.judgeTimeoutMs) ? Math.max(1000, this.config.judgeTimeoutMs) : 30000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const messages = [{ role: 'user', content: [{ type: 'text', text: buildJudgePrompt(todo) }] }];
      let stream;
      if (typeof llm.prepareCall === 'function') {
        const prepared = await llm.prepareCall(route, controller.signal);
        stream = prepared.stream({ ...prepared.config, messages, signal: controller.signal });
      } else {
        stream = llm.stream({ ...route, messages, signal: controller.signal });
      }
      let text = '';
      let chunkCount = 0;
      let firstChunk = null;
      for await (const chunk of stream) {
        chunkCount += 1;
        if (firstChunk === null) firstChunk = chunk;
        text += chunkText(chunk);
        if (text.length > 20000) break;
      }
      if (text === '' && chunkCount > 0) {
        this.logger.warn(`预检流式返回 ${chunkCount} 个分片但无正文：${safeJsonPreview(firstChunk)}`);
      }
      const verdict = parseJudgeReply(text);
      if (!verdict) this.lastJudgeError = judgeOutputError(text);
      return verdict;
    } catch (error) {
      this.lastJudgeError = `预检模型调用失败：${errorMessage(error)}`.slice(0, 300);
      return null;
    } finally {
      clearTimeout(timer);
    }
  },

  /** 批量预检的同目标会话上下文：给 judge 判断 preferSession（reuse/new）用。 */
  batchSameTargetContext(todos) {
    const context = {};
    for (const todo of todos) {
      const key = targetKey(todo?.url ?? '');
      if (!key) continue;
      const candidates = Object.values(this.state.handled)
        .filter((record) => record?.sessionId && record.archived !== true && targetKey(record.url) === key)
        .sort((a, b) => (b.acceptedAt ?? 0) - (a.acceptedAt ?? 0))
        .slice(0, 2)
        .map((record) => ({
          title: record.sessionTitle || record.title,
          status: record.reportStatus || record.closure,
          note: record.closureNote || record.reportSummary,
        }));
      if (candidates.length > 0) context[todo.id] = candidates;
    }
    return context;
  },

  /**
   * 批量预检：一次判定本批全部提及（含优先级/重复/类型/路由倾向）。
   * 任何失败（无 llm、解析不出）返回 null，调用方退回逐条预检。
   */
  async judgeBatchVerdicts(todos) {
    const llm = this.llmRuntime();
    if (!llm) {
      this.lastJudgeError = '宿主未提供 llm 服务，预检不可用。';
      return null;
    }
    const route = await this.judgeModel();
    if (!route) {
      this.lastJudgeError = '没有可用的预检模型（未配置预检/Session 模型，也读不到宿主默认模型）。';
      return null;
    }
    const timeoutMs = Number.isFinite(this.config.judgeBatchTimeoutMs)
      ? Math.max(1000, this.config.judgeBatchTimeoutMs)
      : 60000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const messages = [{
        role: 'user',
        content: [{ type: 'text', text: buildBatchJudgePrompt(todos, { sameTarget: this.batchSameTargetContext(todos) }) }],
      }];
      let stream;
      if (typeof llm.prepareCall === 'function') {
        const prepared = await llm.prepareCall(route, controller.signal);
        stream = prepared.stream({ ...prepared.config, messages, signal: controller.signal });
      } else {
        stream = llm.stream({ ...route, messages, signal: controller.signal });
      }
      let text = '';
      let chunkCount = 0;
      let firstChunk = null;
      for await (const chunk of stream) {
        chunkCount += 1;
        if (firstChunk === null) firstChunk = chunk;
        text += chunkText(chunk);
        if (text.length > 60000) break;
      }
      if (text === '' && chunkCount > 0) {
        this.logger.warn(`批量预检流式返回 ${chunkCount} 个分片但无正文：${safeJsonPreview(firstChunk)}`);
      }
      const verdicts = parseBatchJudgeReply(text);
      if (!verdicts) this.lastJudgeError = judgeOutputError(text);
      return verdicts;
    } catch (error) {
      this.lastJudgeError = `预检模型调用失败：${errorMessage(error)}`.slice(0, 300);
      return null;
    } finally {
      clearTimeout(timer);
    }
  },

  /**
   * 预检入口：先按 precheckEngine 取判定；判定不需要处理或同批重复的直接标记完成。
   * 预检本身失败的 Todo 本轮跳过（不标记、不开会话），留待下一轮重试；连续失败
   * 记录在 precheckFailures 并周期性告警，可随时手动派发。
   * 返回仍需开会话的 Todo，按 judge 优先级（1 最先）稳定排序；
   * 判定存入 judgeVerdicts，派发时消费（preferSession 决定是否路由复用、priority 决定顺序）。
   */
  async precheckMentions(mentions) {
    this.lastJudgeError = '';
    const engine = this.state.settings.precheckEngine ?? 'auto';
    let verdicts = new Map();
    let engineUsed = 'llm';
    if (engine !== 'llm' && typeof this.precheckJevVerdicts === 'function') {
      let jev = null;
      try {
        jev = await this.precheckJevVerdicts(mentions);
      } catch (error) {
        this.logger.warn(`Jev 预检整体失败：${errorMessage(error)}`);
        this.lastJudgeError = `Jev 预检整体失败：${errorMessage(error)}`.slice(0, 300);
      }
      if (jev) {
        engineUsed = 'jev';
        verdicts = jev.verdicts;
        // 低置信（P 落在不确定带）的条目交给 LLM 复核：Jev 担快刀，LLM 担边缘。
        if (jev.uncertain.size > 0) {
          const rechecked = await mapLimit(mentions.filter((todo) => jev.uncertain.has(todo.id)),
            PRECHECK_CONCURRENCY, async (todo) => [todo.id, await this.judgeNeedsProcessing(todo)]);
          for (const [todoId, llmVerdict] of rechecked) {
            if (llmVerdict) {
              const prev = verdicts.get(todoId);
              verdicts.set(todoId, { ...prev, needsProcessing: llmVerdict.needsProcessing, reason: llmVerdict.reason || prev.reason });
            }
          }
        }
        // auto 模式：Jev 漏判（调用失败/无答案）的条目用 LLM 逐条补齐，不整批回退。
        if (engine === 'auto') {
          const missing = mentions.filter((todo) => !verdicts.has(todo.id));
          if (missing.length > 0) {
            const filled = await mapLimit(missing, PRECHECK_CONCURRENCY,
              async (todo) => [todo.id, await this.judgeNeedsProcessing(todo)]);
            for (const [todoId, llmVerdict] of filled) {
              if (llmVerdict) verdicts.set(todoId, llmVerdict);
            }
          }
        }
      } else if (engine === 'auto') {
        // Jev 整体不可用：auto 自动回退 LLM。
        engineUsed = 'llm';
      } else {
        // engine === 'jev'：严格模式，Jev 不可用就整轮跳过（verdicts 保持空），不走 LLM。
        engineUsed = 'jev';
      }
    }
    if (engineUsed === 'llm') {
      verdicts = await this.judgeBatchVerdicts(mentions)
        ?? new Map((await mapLimit(mentions, PRECHECK_CONCURRENCY,
          async (todo) => [todo.id, await this.judgeNeedsProcessing(todo)]))
          .filter(([, verdict]) => verdict !== null));
    }
    this.lastPrecheckEngine = engineUsed;
    for (const todo of mentions) {
      if (verdicts.has(todo.id)) this.precheckFailures.delete(todo.id);
    }
    // 重复折叠的判定条件：duplicateOf 指向本批另一条“需要处理”的 Todo，且两者在同一个
    // 目标对象上（去掉 note 锚点后同源）——跨讨论串的重复提问不折叠，否则另一线程将无人回应。
    const foldableInto = (todo, verdict) => {
      if (!verdict) return null;
      const target = verdict.duplicateOf && verdict.duplicateOf !== todo.id
        ? mentions.find((item) => item.id === verdict.duplicateOf)
        : null;
      if (!target) return null;
      if (verdicts.get(verdict.duplicateOf)?.needsProcessing !== true) return null;
      if (targetKey(target.url) !== targetKey(todo.url) || !targetKey(todo.url)) return null;
      return target;
    };
    // 被别的重复项指向的主条目集合：主条目自身不再折叠（避免 a→b、b→a 互相指向时双双标完成）。
    const referencedPrimaries = new Set();
    for (const todo of mentions) {
      const target = foldableInto(todo, verdicts.get(todo.id));
      if (target) referencedPrimaries.add(target.id);
    }
    const ready = [];
    let degraded = 0;
    const missing = mentions.filter((todo) => !verdicts.has(todo.id)).length;
    // 面板可见：预检失败的原因与影响（跳过 / 降级），成功后清除。
    this.state.lastPrecheckError = missing === 0
      ? null
      : `预检失败 ${missing}/${mentions.length} 条：${this.lastJudgeError || '原因未知'}（连续 ${PRECHECK_MAX_SKIPS} 轮失败后将降级为直接派发）`;
    for (const todo of mentions) {
      const verdict = verdicts.get(todo.id);
      if (!verdict) {
        // 预检本身失败（服务不可用/超时/输出不可解析）：本轮跳过，不标记、不开会话，
        // 下一轮重试；连续失败告警。手动“开 Session 处理”不受影响。
        const failures = (this.precheckFailures.get(todo.id) ?? 0) + 1;
        this.precheckFailures.set(todo.id, failures);
        const reason = this.lastJudgeError || '预检失败（原因未知）';
        if (failures < PRECHECK_MAX_SKIPS) {
          this.logger.warn(`Todo ${todo.id} 预检第 ${failures} 轮失败，本轮跳过、下一轮重试：${reason}`);
          continue;
        }
        // 连续失败达到上限：预检不可用不应让自动处理永久停摆——降级为直接派发（会话自身的
        // “仅被提及”判定与危险操作护栏仍然生效），并把原因留在面板上。
        this.logger.warn(`Todo ${todo.id} 预检连续 ${failures} 轮失败，降级为直接派发：${reason}`);
        degraded += 1;
        ready.push(todo);
        continue;
      }
      const target = foldableInto(todo, verdict);
      const duplicate = Boolean(target) && !referencedPrimaries.has(todo.id);
      if (!verdict.needsProcessing || duplicate) {
        const reason = duplicate
          ? `与 Todo ${verdict.duplicateOf} 是同一请求，随主条目合并处理`
          : verdict.reason;
        try {
          await this.markTodoDone(todo);
          this.state.handled[todo.id] = {
            id: todo.id,
            sessionId: null,
            outcome: 'precheck-skipped',
            automatic: true,
            acceptedAt: Date.now(),
            skipReason: reason,
            title: todo.title,
            url: todo.url,
            project: todo.project,
            // 折叠进主条目的提及：保留作者与正文摘录，主条目会话提示词会带出并要求覆盖处理。
            ...(duplicate ? {
              mergedInto: target.id,
              author: todo.author,
              excerpt: String(todo.body ?? '').slice(0, 300),
            } : {}),
          };
        } catch (error) {
          this.logger.warn(`预检跳过 Todo ${todo.id} 标记完成失败：${errorMessage(error)}`);
          // 标记失败时不丢判定：下一轮该 Todo 仍在待办列表，避免周期性重复调用预检模型。
          continue;
        }
        this.judgeVerdicts.delete(todo.id);
        continue;
      }
      this.judgeVerdicts.set(todo.id, verdict);
      ready.push(todo);
    }
    return ready
      .map((todo) => ({ todo, priority: Number(verdicts.get(todo.id)?.priority) || 3 }))
      .sort((a, b) => a.priority - b.priority)
      .map((entry) => entry.todo);
  },
};
