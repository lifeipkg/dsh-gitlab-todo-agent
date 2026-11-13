import { readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  buildJevDuplicatePairs,
  buildJevMatchQuestions,
  buildJevMatchState,
  buildJevQuestions,
  buildJevState,
  SYSTEMONE_PRESETS,
  verdictFromJevAnswers,
  verdictFromJevMatch,
} from '../core.js';
import { PRECHECK_CONCURRENCY } from './constants.js';
import { errorMessage, mapLimit } from './util.js';

/**
 * Jev/System One 预检：决策模型（返回带概率的结构化答案，不生成文本）。
 * 调用面三层降级，按序探测，首个可用者生效：
 *   1. 宿主 llm 服务暴露 classify（未来 DSH 版本；当前没有）；
 *   2. PATH 上的 jev CLI（jevctl，读 ~/.config/jev/credentials.json，自带代理配置）；
 *   3. System One HTTP 直连（api.typesafe.ai / OpenRouter / Cloudflare / 自建兼容端），
 *      凭证链：设置里的 apiKey → 环境变量 → jevctl 凭证文件。
 * 全部不可用时返回 null，由调用方回退 LLM（auto）或跳过本轮（jev 严格模式）。
 */
export const precheckJevMethods = {

  /**
   * 解析后的分类器配置：用户 precheckClassifier 覆盖在 provider 预设之上。
   * provider 缺省 typesafe；model/baseUrl/apiKeyEnv 未给时取预设。
   */
  classifierConfig() {
    const override = this.state?.settings?.precheckClassifier ?? null;
    const provider = (override?.provider || 'typesafe').trim().toLowerCase();
    const preset = SYSTEMONE_PRESETS[provider] ?? {};
    return {
      provider,
      model: override?.model?.trim() || preset.modelId || 'jev-latest',
      baseUrl: override?.baseUrl?.trim() || preset.baseUrl || '',
      apiKeyEnv: override?.apiKeyEnv?.trim() || preset.apiKeyEnv || '',
      apiKey: override?.apiKey?.trim() || '',
      accountId: override?.accountId?.trim() || '',
      timeoutMs: Number.isSafeInteger(override?.timeoutMs)
        ? Math.max(1000, Math.min(override.timeoutMs, 120000))
        : 30000,
    };
  },

  /** 宿主暴露的 classifier（将来 DSH 把 models.classify 挂进 llm 服务时自动生效）。 */
  nativeClassifier() {
    const llm = this.llmRuntime?.();
    if (llm && typeof llm.classify === 'function') {
      return async (route, request, signal) => llm.classify(route, request, { signal });
    }
    if (typeof this.ctx.get === 'function') {
      try {
        const registry = this.ctx.get('modelRegistry');
        if (registry && typeof registry.classify === 'function') {
          return async (route, request, signal) => registry.classify(
            { provider: route.provider, id: route.model },
            request,
            { signal },
          );
        }
      } catch {
        // 没有 modelRegistry 服务属正常，落到下一层。
      }
    }
    return null;
  },

  /** 子进程执行器（测试可经 config.jevSpawn 注入替身）。 */
  runJevCli(args, timeoutMs) {
    const runner = this.config.jevSpawn;
    if (typeof runner === 'function') return runner(args, timeoutMs);
    return new Promise((resolve) => {
      // shell:true 才能命中 PATH 上的 jev.cmd 包装（内含代理环境变量）。
      const child = spawn('jev', args, { shell: true, windowsHide: true });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        resolve({ code: -1, stdout, stderr: `${stderr}\nCLI 超时（${timeoutMs}ms）`.trim() });
      }, timeoutMs);
      timer.unref?.();
      child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: errorMessage(error) });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  },

  /** jev CLI 可用性（缓存结果，避免每轮探测）。 */
  async jevCliAvailable() {
    if (this._jevCliAvailable !== undefined) return this._jevCliAvailable;
    const result = await this.runJevCli(['--version'], 8000);
    this._jevCliAvailable = result.code === 0 && /\d+\.\d+/.test(result.stdout + result.stderr);
    return this._jevCliAvailable;
  },

  /**
   * System One 凭证解析：
   *   1. precheckClassifier.apiKey（明文设置，不推荐但在本地环境可用）；
   *   2. 环境变量（apiKeyEnv，预设默认 TYPESAFE_API_KEY/OPENROUTER_API_KEY）；
   *   3. jevctl 凭证文件 ~/.config/jev/credentials.json 里同 provider 的键。
   */
  async resolveSystemOneKey(config) {
    if (config.apiKey) return config.apiKey;
    if (config.apiKeyEnv) {
      const envValue = process.env[config.apiKeyEnv];
      if (envValue) return envValue;
    }
    try {
      const store = JSON.parse(
        await readFile(join(homedir(), '.config', 'jev', 'credentials.json'), 'utf8'),
      );
      const key = store?.[config.provider];
      if (typeof key === 'string' && key.trim()) return key.trim();
    } catch {
      // 无 jevctl 凭证属正常。
    }
    return '';
  },

  /** System One HTTP 直连：POST {baseUrl}/systemone，body {model,state,questions}。 */
  async classifyViaHttp(config, request, signal) {
    const fetchImpl = this.config.systemOneFetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw new Error('运行时不支持 fetch。');
    const key = await this.resolveSystemOneKey(config);
    if (!key) {
      throw new Error(`没有可用的分类器凭证（${config.apiKeyEnv || 'apiKey'} 未设置，jevctl 凭证也无 ${config.provider}）。`);
    }
    const url = `${config.baseUrl.replace(/\/+$/, '')}/systemone`;
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        ...(config.accountId ? { 'cf-account-id': config.accountId } : {}),
      },
      body: JSON.stringify(request),
      signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = body?.error?.message ?? body?.message ?? response.statusText ?? '';
      throw new Error(`System One HTTP ${response.status}${detail ? `：${String(detail).slice(0, 200)}` : ''}`);
    }
    if (!body || typeof body !== 'object' || !body.answers) {
      throw new Error('System One 应答缺少 answers 字段。');
    }
    return body;
  },

  /** jev CLI 调用：state 与 questions 各落一个临时文件，避免命令行转义；--state-json + --json。 */
  async classifyViaCli(request, timeoutMs) {
    const dir = this.storageDirectory();
    const stateFile = join(dir, `.jev-state-${randomUUID()}.json`);
    const questionsFile = join(dir, `.jev-questions-${randomUUID()}.json`);
    try {
      await writeFile(stateFile, JSON.stringify(request.state), 'utf8');
      await writeFile(questionsFile, JSON.stringify(request.questions), 'utf8');
      const args = ['ask', `@${stateFile}`, '--state-json', '--questions', `@${questionsFile}`, '--json'];
      const config = this.classifierConfig();
      if (config.model && config.model !== 'jev-latest') args.push('--model', config.model);
      if (['typesafe', 'openrouter', 'cloudflare'].includes(config.provider)) args.push('--provider', config.provider);
      const result = await this.runJevCli(args, timeoutMs);
      if (result.code !== 0) {
        throw new Error(`jev CLI 退出码 ${result.code}：${(result.stderr || result.stdout || '').trim().slice(0, 300) || '无输出'}`);
      }
      const text = String(result.stdout ?? '').trim();
      const start = text.indexOf('{');
      if (start < 0) throw new Error('jev CLI 没有输出 JSON。');
      const parsed = JSON.parse(text.slice(start));
      if (!parsed?.answers) throw new Error('jev CLI 应答缺少 answers 字段。');
      return parsed;
    } finally {
      await unlink(stateFile).catch(() => {});
      await unlink(questionsFile).catch(() => {});
    }
  },

  /**
   * 统一分类调用：按 宿主 classify → jev CLI → HTTP 顺序取首个可用通道。
   * 返回 {answers, transport}；所有通道失败抛带汇总信息的 Error（调用方按失败处理）。
   */
  async classifyOne(request, timeoutMs) {
    const config = this.classifierConfig();
    const errors = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const native = this.nativeClassifier();
      if (native) {
        try {
          const result = await native(
            { provider: config.provider, model: config.model },
            { state: request.state, questions: request.questions },
            controller.signal,
          );
          if (result?.stopReason === 'error') throw new Error(`宿主分类器报错：${result.error?.message ?? '未知'}`);
          if (result?.answers) return { answers: result.answers, transport: 'host-classifier' };
          throw new Error('宿主分类器应答缺少 answers。');
        } catch (error) {
          errors.push(`宿主分类器：${errorMessage(error)}`);
        }
      }
      if (await this.jevCliAvailable()) {
        try {
          const result = await this.classifyViaCli(request, timeoutMs);
          return { answers: result.answers, transport: 'jev-cli' };
        } catch (error) {
          errors.push(`jev CLI：${errorMessage(error)}`);
        }
      }
      if (config.baseUrl) {
        try {
          const result = await this.classifyViaHttp(config, request, controller.signal);
          return { answers: result.answers, transport: `http:${config.provider}` };
        } catch (error) {
          errors.push(`${config.provider} HTTP：${errorMessage(error)}`);
        }
      }
      throw new Error(errors.join('；') || '没有可用的分类器通道。');
    } finally {
      clearTimeout(timer);
    }
  },

  /** 单条 Todo 的 Jev 判定：返回与聊天判定同构的 verdict（含 jev 概率字段），失败抛错。 */
  async jevJudgeTodo(todo, sameTargetSessions = [], batchPeers = []) {
    const config = this.classifierConfig();
    const request = {
      model: config.model,
      state: buildJevState(todo, { sameTargetSessions, batchPeers }),
      questions: buildJevQuestions(todo, { sameTargetSessions }),
    };
    const { answers, transport } = await this.classifyOne(request, config.timeoutMs);
    const verdict = verdictFromJevAnswers(answers);
    if (!verdict) throw new Error('Jev 应答缺少 needs 概率。');
    verdict.transport = transport;
    return verdict;
  },

  /** 成对 match：同目标两条 Todo 是否同一请求。失败返回 null（不影响主判定）。 */
  async jevMatchPair(a, b) {
    const config = this.classifierConfig();
    const request = {
      model: config.model,
      state: buildJevMatchState(a, b),
      questions: buildJevMatchQuestions(a, b),
    };
    const { answers } = await this.classifyOne(request, config.timeoutMs);
    return verdictFromJevMatch(answers);
  },

  /**
   * Jev 批量判定：逐条并行判定 + 同目标成对去重。
   * 返回 { verdicts: Map<todoId,verdict>, uncertain: Set<todoId>, transport }；
   * 没有可用分类器通道返回 null。uncertain 集合由调用方交给 LLM 复核。
   */
  async precheckJevVerdicts(mentions) {
    const config = this.classifierConfig();
    const usable = this.nativeClassifier() || (await this.jevCliAvailable()) || (config.baseUrl && (await this.resolveSystemOneKey(config)));
    if (!usable) {
      this.lastJudgeError = 'Jev 预检不可用：宿主无 classify 服务、PATH 无 jev CLI、也未配置 System One 凭证。';
      return null;
    }
    const sameTarget = this.batchSameTargetContext(mentions);
    const judged = await mapLimit(mentions, PRECHECK_CONCURRENCY, async (todo) => {
      try {
        return [todo.id, await this.jevJudgeTodo(todo, sameTarget[todo.id] ?? [], mentions.filter((peer) => peer.id !== todo.id))];
      } catch (error) {
        this.ctx.logger?.warn?.(`[gitlab-todo-agent] Todo ${todo.id} Jev 判定失败：${errorMessage(error)}`);
        return [todo.id, null];
      }
    });
    const verdicts = new Map(judged.filter(([, verdict]) => verdict !== null));
    const uncertain = new Set([...verdicts].filter(([, verdict]) => verdict.jev?.uncertain).map(([id]) => id));
    // 同目标成对 match 决定去重：只在双方都判定需要处理时才值得折叠。
    const pairs = buildJevDuplicatePairs(mentions).filter(([a, b]) =>
      verdicts.get(a.id)?.needsProcessing === true && verdicts.get(b.id)?.needsProcessing === true);
    if (pairs.length > 0) {
      const primaries = new Set();
      await mapLimit(pairs, PRECHECK_CONCURRENCY, async ([a, b]) => {
        if (verdicts.get(a.id)?.duplicateOf || primaries.has(b.id)) return;
        let match = null;
        try {
          match = await this.jevMatchPair(a, b);
        } catch (error) {
          this.ctx.logger?.warn?.(`[gitlab-todo-agent] Todo ${a.id}/${b.id} Jev 去重判定失败：${errorMessage(error)}`);
          return;
        }
        if (match?.duplicate) {
          verdicts.get(b.id).duplicateOf = a.id;
          primaries.add(a.id);
        }
      });
    }
    this.lastJevTransport = judged.find(([, verdict]) => verdict?.transport)?.[1]?.transport ?? 'unknown';
    return { verdicts, uncertain, transport: this.lastJevTransport };
  },
};
