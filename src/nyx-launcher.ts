import type { Agent } from './types.js';
import type { AgentTuning, LaunchContext, Launcher, RunResult } from './launcher.js';

export interface NyxAgentConfig {
  /** Base URL of Nyx's API, e.g. http://127.0.0.1:8000. */
  url: string;
  /** Bearer token accepted by Nyx. Empty means no Authorization header. */
  token?: string;
  /** Delay between status polls. Defaults to 250 ms. */
  pollIntervalMs?: number;
}

export interface NyxLauncherOpts extends NyxAgentConfig {
  timeoutMs: number;
  /** Injectable for tests; defaults to the platform fetch implementation. */
  fetchFn?: typeof fetch;
}

const OUTPUT_LIMIT = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const TERMINAL_FAILURES = new Set(['failed', 'stopped', 'cancelled', 'canceled', 'error']);

class NyxTimeoutError extends Error {}

const asErrorText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
};

const transcriptText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
};

export class NyxLauncher implements Launcher {
  private readonly fetchFn: typeof fetch;

  constructor(private opts: NyxLauncherOpts) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  launch(
    agent: Agent,
    prompt: string,
    cwd: string,
    onOutput?: (chunk: string) => void,
    tuning?: AgentTuning,
    context?: LaunchContext,
  ): Promise<RunResult> {
    if (agent !== 'nyx') {
      return Promise.resolve(this.failed(`NyxLauncher received non-nyx agent ${agent}`));
    }

    return this.run(cwd, onOutput, context, prompt, tuning);
  }

  private async run(cwd: string, onOutput: ((chunk: string) => void) | undefined, context: LaunchContext | undefined, prompt: string, tuning?: AgentTuning): Promise<RunResult> {
    let output = '';
    let streamedTranscript = '';
    const append = (chunk: string): void => {
      output = (output + chunk).slice(-OUTPUT_LIMIT);
      onOutput?.(chunk);
    };
    const streamTranscript = (value: unknown): void => {
      if (Array.isArray(value)) {
        const next = value.map(item => `${transcriptText(item)}\n`).join('');
        const delta = next.startsWith(streamedTranscript) ? next.slice(streamedTranscript.length) : next;
        if (delta) append(delta);
        streamedTranscript = next;
        return;
      }
      if (typeof value === 'string') {
        const delta = value.startsWith(streamedTranscript) ? value.slice(streamedTranscript.length) : value;
        if (delta) append(delta.endsWith('\n') ? delta : `${delta}\n`);
        streamedTranscript = value;
      }
    };

    try {
      const baseUrl = this.baseUrl();
      const deadline = Date.now() + Math.max(1, this.opts.timeoutMs);
      const cardText = context
        ? [context.task.title.trim(), context.task.description.trim()].filter(Boolean).join('\n\n')
        : prompt.trim();
      const post = await this.request(`${baseUrl}/coding/tasks`, deadline, {
        method: 'POST',
        body: JSON.stringify({
          // Nyx's endpoint calls the combined title + description "task".
          task: cardText || '(no task description)',
          workspace_path: cwd,
          base_branch: context?.baseBranch || 'main',
          // A card's model column pins a bigger coder for this task; Nyx honours it.
          ...(tuning?.model ? { model: tuning.model } : {}),
        }),
      });
      const taskId = asErrorText(post.id).trim();
      if (!taskId) throw new Error('Nyx POST /coding/tasks returned no task id');

      while (true) {
        const status = await this.request(`${baseUrl}/coding/tasks/${encodeURIComponent(taskId)}`, deadline, { method: 'GET' });
        streamTranscript(status.transcript);
        const state = asErrorText(status.status).toLowerCase();
        if (state === 'ready_for_review') {
          return {
            ok: true, timedOut: false, exitCode: 0, outputTail: output,
            inputTokens: 0, outputTokens: 0, costEstimate: 0,
          };
        }
        if (TERMINAL_FAILURES.has(state)) {
          const detail = asErrorText(status.error || status.reason).trim();
          if (detail) append(`\n[nyx] ${detail}\n`);
          return {
            ok: false, timedOut: false, exitCode: 1, outputTail: output || '[nyx] task failed',
            inputTokens: 0, outputTokens: 0, costEstimate: 0,
          };
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new NyxTimeoutError('Nyx task polling timed out');
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(this.pollIntervalMs(), remaining)));
      }
    } catch (error) {
      if (error instanceof NyxTimeoutError || (error instanceof Error && error.name === 'AbortError')) {
        const message = `[nyx] ${error.message || 'task timed out'}`;
        append(`\n${message}\n`);
        return {
          ok: false, timedOut: true, exitCode: null, outputTail: output,
          inputTokens: 0, outputTokens: 0, costEstimate: 0,
        };
      }
      const message = `[nyx] ${error instanceof Error ? error.message : String(error)}`;
      append(`\n${message}\n`);
      return {
        ok: false, timedOut: false, exitCode: null, outputTail: output,
        inputTokens: 0, outputTokens: 0, costEstimate: 0,
      };
    }
  }

  private baseUrl(): string {
    const url = this.opts.url.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(url)) throw new Error('agents.nyx.url must be an http(s) URL');
    return url;
  }

  private pollIntervalMs(): number {
    return Math.max(1, this.opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }

  private async request(url: string, deadline: number, init: RequestInit): Promise<Record<string, unknown>> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new NyxTimeoutError('Nyx task polling timed out');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const headers = new Headers(init.headers);
      headers.set('accept', 'application/json');
      if (init.method === 'POST') headers.set('content-type', 'application/json');
      const token = (this.opts.token ?? '').trim() || (process.env.NYX_CODING_TOKEN ?? '').trim();
      if (token) headers.set('authorization', `Bearer ${token}`);
      const response = await this.fetchFn(url, { ...init, headers, signal: controller.signal });
      const text = await response.text();
      let body: unknown = {};
      if (text) {
        try { body = JSON.parse(text); } catch { body = { detail: text }; }
      }
      if (!response.ok) {
        const detail = body && typeof body === 'object' ? asErrorText((body as Record<string, unknown>).detail) : '';
        throw new Error(`${init.method ?? 'GET'} ${new URL(url).pathname} returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 1000)}` : ''}`);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Nyx returned a non-object JSON response');
      return body as Record<string, unknown>;
    } catch (error) {
      if (controller.signal.aborted) throw new NyxTimeoutError('Nyx request timed out');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private failed(outputTail: string): RunResult {
    return { ok: false, timedOut: false, exitCode: null, outputTail, inputTokens: 0, outputTokens: 0, costEstimate: 0 };
  }
}
