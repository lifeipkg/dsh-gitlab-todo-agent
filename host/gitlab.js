import { spawn } from 'node:child_process';
import { normalizeTodos } from '../core.js';
import { MAX_TODO_PAGES, TODO_PAGE_SIZE } from './constants.js';
import { errorMessage } from './util.js';

/**
 * GitLab 访问层：glab 子进程、当前用户、Todo 分页拉取、标记完成。
 * 全部方法挂在 GitlabTodoRuntime 原型上（见 index.js attachRuntimeMethods），
 * this 指向运行时实例：state/config/activeChildren/gitlabUserId 等字段共享。
 */
export const gitlabMethods = {

  async currentGitlabUserId() {
    if (this.gitlabUserId) return this.gitlabUserId;
    const stdout = await this.runGlab(['api', 'user']);
    let user;
    try {
      user = JSON.parse(stdout);
    } catch (error) {
      throw new Error(`解析 GitLab 当前用户失败：${errorMessage(error)}`);
    }
    if ((typeof user?.id !== 'number' && typeof user?.id !== 'string') || !String(user.id).trim()) {
      throw new Error('GitLab 当前用户响应缺少有效 id。');
    }
    this.gitlabUserId = String(user.id).trim();
    this.gitlabUsername = typeof user.username === 'string' && user.username.trim() ? user.username.trim() : null;
    return this.gitlabUserId;
  },

  async fetchTodos() {
    await this.currentGitlabUserId();
    const items = [];
    for (let page = 1; page <= MAX_TODO_PAGES; page += 1) {
      const stdout = await this.runGlab([
        'api', '-X', 'GET', 'todos',
        '-F', `per_page=${TODO_PAGE_SIZE}`,
        '-F', `page=${page}`,
      ]);
      let pageItems;
      try {
        pageItems = JSON.parse(stdout);
      } catch (error) {
        throw new Error(`解析 GitLab Todo 第 ${page} 页失败：${errorMessage(error)}`);
      }
      if (!Array.isArray(pageItems)) throw new Error(`GitLab Todo 第 ${page} 页响应不是数组。`);
      if (pageItems.length === 0) break;
      items.push(...pageItems);
      if (pageItems.length < TODO_PAGE_SIZE) break;
    }
    return normalizeTodos(items);
  },

  async markTodoDone(todo) {
    await this.runGlab(['api', '-X', 'POST', `todos/${encodeURIComponent(todo.id)}/mark_as_done`]);
  },

  async runGlab(args) {
    const timeoutMs = Number.isFinite(this.config.requestTimeoutMs)
      ? Math.max(1000, this.config.requestTimeoutMs)
      : 90000;
    const maxOutputBytes = Number.isSafeInteger(this.config.maxOutputBytes)
      ? Math.max(1024, this.config.maxOutputBytes)
      : 2097152;
    const executable = process.platform === 'win32' ? 'glab.exe' : 'glab';
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: this.state.settings.cwd || process.cwd(),
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.activeChildren.add(child);
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let failure = null;
      let settled = false;
      let forceTimer = null;
      const timeout = setTimeout(() => {
        failure = new Error(`GitLab 请求超过 ${timeoutMs}ms，已终止。`);
        child.kill();
        forceTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
        forceTimer.unref?.();
      }, timeoutMs);
      timeout.unref?.();

      const finish = (error, code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(forceTimer);
        this.activeChildren.delete(child);
        const out = Buffer.concat(stdout).toString('utf8');
        const err = Buffer.concat(stderr).toString('utf8');
        if (error) {
          reject(error);
          return;
        }
        if (failure) {
          const detail = err.trim();
          reject(new Error(`${failure.message}${detail ? `：${detail.slice(0, 2000)}` : ''}`));
          return;
        }
        if (code !== 0) {
          const detail = err.trim() || out.trim();
          reject(new Error(`glab 退出码 ${code ?? 'null'}（${signal ?? '无信号'}）${detail ? `：${detail.slice(0, 2000)}` : ''}`));
          return;
        }
        resolve(out);
      };

      child.stdout.on('data', (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxOutputBytes) {
          failure = new Error(`GitLab 标准输出超过 ${maxOutputBytes} 字节上限。`);
          child.kill();
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes > maxOutputBytes) {
          failure = new Error(`GitLab 标准错误超过 ${maxOutputBytes} 字节上限。`);
          child.kill();
          return;
        }
        stderr.push(chunk);
      });
      child.once('error', (error) => finish(error));
      child.once('close', (code, signal) => finish(null, code, signal));
    });
  },
};
