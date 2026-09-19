import { existsSync, realpathSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute } from 'node:path';
import type { Launcher, RunResult } from './launcher.js';
import type { Agent } from './types.js';
import type { WorkOrder } from './remote.js';
import { buildPrompt } from './prompt.js';

export interface WorkerOptions {
  boardUrl: string; id: string; token: string; agents: Agent[]; projects: Record<string, string>;
  pollMs?: number;
  /** Waits between completion retries. Heartbeats continue meanwhile so the lease survives a board blip. */
  completeRetryMs?: number[];
  launcher: (order: WorkOrder) => Promise<Launcher> | Launcher;
  cleanup?: (order: WorkOrder) => Promise<void> | void;
}

class WorkerHttpError extends Error {
  constructor(path: string, readonly status: number) {
    super(`Worker request ${path} returned HTTP ${status}`);
  }
}

const execFileAsync = promisify(execFile);

async function gitMetadata(cwd: string): Promise<{ headSha?: string; dirtyFiles?: number }> {
  const git = async (...args: string[]) => (await execFileAsync('git', args, { cwd, timeout: 5000, windowsHide: true, encoding: 'utf8' })).stdout.trim();
  try {
    if (await git('rev-parse', '--is-inside-work-tree') !== 'true') return {};
    const headSha = await git('rev-parse', 'HEAD');
    const status = await git('status', '--porcelain');
    return { headSha, dirtyFiles: status ? status.split(/\r?\n/).length : 0 };
  } catch { return {}; }
}

/** One active run per worker, with explicit local project allowlisting. */
export class RemoteWorker {
  private base: string;
  private paths: Record<string, string> = {};
  private busy = false;
  constructor(private opts: WorkerOptions) {
    const url = new URL(opts.boardUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid board URL');
    this.base = url.href.replace(/\/$/, '');
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(opts.id) || opts.token.length < 32) throw new Error('Invalid worker id/token');
    for (const [name, dir] of Object.entries(opts.projects)) {
      if (!isAbsolute(dir) || !existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Project ${name} needs an existing absolute directory`);
      this.paths[name] = realpathSync(dir);
    }
  }
  private async request(path: string, body: unknown, token?: string): Promise<any> {
    const response = await fetch(`${this.base}/workers/${this.opts.id}${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${this.opts.token}`, 'content-type': 'application/json', ...(token ? { 'x-run-token': token } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    if (!response.ok) throw new WorkerHttpError(path, response.status);
    return response.json();
  }
  private async requestWithRetries(path: string, body: unknown, token: string): Promise<void> {
    const delays = this.opts.completeRetryMs ?? [1000, 2000, 4000, 8000, 16000];
    let failure: unknown;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, delays[attempt - 1]));
      try { await this.request(path, body, token); return; }
      catch (e) { failure = e; }
    }
    throw failure;
  }
  async once(signal?: AbortSignal): Promise<boolean> {
    if (this.busy) throw new Error('Worker already has an active poll/run');
    this.busy = true;
    try { return await this.runOnce(signal); } finally { this.busy = false; }
  }
  private async runOnce(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    const order: WorkOrder | null = await this.request('/claim', { agents: this.opts.agents, projects: Object.keys(this.paths) });
    if (!order) return false;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let tail = '';
    let lastAck = Date.now();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: Promise<void> = Promise.resolve();
    const beat = () => {
      heartbeat = (async () => {
        try {
          await this.request(`/runs/${order.runId}/heartbeat`, { output: tail }, order.token);
          lastAck = Date.now();
        } catch {
          if (Date.now() - lastAck >= order.leaseMs / 2) controller.abort();
        }
        if (!stopped) timer = setTimeout(beat, Math.min(5000, order.leaseMs / 4));
      })();
    };
    beat();
    let result: RunResult;
    let processExited = false;
    try {
      const cwd = this.paths[order.project];
      if (!cwd || realpathSync(cwd) !== cwd) throw new Error('Unmapped or changed project path');
      const launcher = await this.opts.launcher(order);
      const prompt = buildPrompt({
        task: order.task, agent: order.task.assignee as Agent, comments: order.comments,
        project: { id: order.task.project_id, name: order.project, path: cwd, created_at: '' },
        remote: { workerId: this.opts.id },
      });
      result = await launcher.launch(order.task.assignee as Agent, prompt, cwd, chunk => { tail = (tail + chunk).slice(-20_000); },
        { model: order.task.model ?? undefined, effort: order.task.effort ?? undefined }, { task: order.task, baseBranch: 'HEAD', signal: controller.signal });
      processExited = true;
      if (controller.signal.aborted) result = { ...result, ok: false, timedOut: true, exitCode: null };
    } catch (e) {
      result = { ok: false, timedOut: controller.signal.aborted, exitCode: null, outputTail: String(e).slice(-20_000), inputTokens: 0, outputTokens: 0, costEstimate: 0 };
    } finally {
      signal?.removeEventListener('abort', abort);
    }
    try {
      // Idempotent completion: retry a lost response without rerunning the task. Heartbeats are
      // still running, so the lease stays valid across a short board outage.
      const metadata = processExited ? await gitMetadata(this.paths[order.project]) : {};
      try {
        await this.requestWithRetries(`/runs/${order.runId}/complete`, { ...result, ...metadata }, order.token);
        return true;
      } catch (failure) {
        if (processExited && failure instanceof WorkerHttpError && failure.status === 409) {
          const evidence = { exitedAt: new Date().toISOString(), exitCode: result.exitCode };
          try { await this.requestWithRetries(`/runs/${order.runId}/exited`, evidence, order.token); }
          catch (e) { console.error(String(e)); }
        }
        throw failure;
      }
    } finally {
      stopped = true;
      if (timer) clearTimeout(timer);
      await heartbeat;
      await this.opts.cleanup?.(order);
    }
  }
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try { await this.once(signal); } catch (e) { console.error(String(e)); }
      if (!signal.aborted) await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, this.opts.pollMs ?? 3000);
        signal.addEventListener('abort', done, { once: true });
      });
    }
  }
}
