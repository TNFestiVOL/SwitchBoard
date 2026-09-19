import { spawn } from 'node:child_process';
import type { Agent, Task } from './types.js';

export interface LaunchContext {
  signal?: AbortSignal;
  /** The board card that is being dispatched. */
  task: Pick<Task, 'title' | 'description'>;
  /** The branch Switchboard will merge the run worktree back into. */
  baseBranch: string;
}

export interface RunResult {
  ok: boolean;
  timedOut: boolean;
  uncertain?: string;
  exitCode: number | null;
  outputTail: string;
  inputTokens: number;
  outputTokens: number;
  costEstimate: number;
}

export interface Launcher {
  launch(
    agent: Agent,
    prompt: string,
    cwd: string,
    onOutput?: (chunk: string) => void,
    tuning?: AgentTuning,
    context?: LaunchContext,
  ): Promise<RunResult>;
}

export interface AgentTuning {
  /** Model name passed to the CLI (claude --model / codex -m). Empty = CLI default. */
  model?: string;
  /** claude: thinking budget (off|low|medium|high or a number → MAX_THINKING_TOKENS).
   *  codex: reasoning effort (minimal|low|medium|high → model_reasoning_effort). */
  effort?: string;
}

export interface CliLauncherOpts {
  /** Per-launcher environment; worker credentials can be removed from child processes. */
  env?: Record<string, string | undefined>;
  claudeCmd: string;
  codexCmd: string;
  geminiCmd: string;
  deepseekCmd: string;
  claudeMcpConfigPath: string;
  /** opencode config JSON (switchboard MCP) handed to deepseek runs via OPENCODE_CONFIG. */
  opencodeMcpConfigPath?: string;
  timeoutMs: number;
  authPromptPatterns?: string[];
  authGraceMs?: number;
  claudeExtraArgs?: string[];
  codexExtraArgs?: string[];
  geminiExtraArgs?: string[];
  deepseekExtraArgs?: string[];
  claudeTuning?: AgentTuning;
  codexTuning?: AgentTuning;
  geminiTuning?: AgentTuning;
  deepseekTuning?: AgentTuning;
  /** Tools headless claude may use without prompting. Default: board tools + Bash so it can run tests. */
  claudeAllowedTools?: string[];
  /** Test hook: use the agent commands verbatim with no default args. */
  rawCommands?: boolean;
}

const CLAUDE_THINKING_TOKENS: Record<string, string> = {
  off: '0', low: '4000', medium: '16000', high: '32000', xhigh: '48000', max: '63999',
};

/** agy only has low|medium|high effort knobs; clamp the shared ladder onto them. */
const GEMINI_EFFORTS: Record<string, string> = {
  off: 'low', minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high',
};

/** Build the shell command (and any env overrides) for one agent run. Exported for tests.
 *  `override` (per-task tuning) wins over the agent's configured default where set.
 *  When `args` is present the launcher spawns `cmd` with that args array (no shell) and
 *  appends the prompt as the final argument — agy's -p requires the prompt as a flag value
 *  and cmd.exe mangles multiline quoted args, so the shell+stdin path would silently
 *  truncate it. Without `args`, the legacy shell-string + stdin path is used. */
export function buildAgentCommand(agent: Agent, opts: CliLauncherOpts, override?: AgentTuning): { cmd: string; env?: Record<string, string>; args?: string[] } {
  if (agent === 'nyx') throw new Error('nyx is HTTP-only and cannot be launched as a CLI');
  if (opts.rawCommands) {
    const raw = agent === 'claude' ? opts.claudeCmd
      : agent === 'gemini' ? opts.geminiCmd
      : agent === 'deepseek' ? opts.deepseekCmd
      : opts.codexCmd;
    return { cmd: raw };
  }
  const merged = (base?: AgentTuning): AgentTuning => ({
    ...(base ?? {}),
    ...(override?.model ? { model: override.model } : {}),
    ...(override?.effort ? { effort: override.effort } : {}),
  });
  if (agent === 'claude') {
    const tuning = merged(opts.claudeTuning);
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--mcp-config', q(opts.claudeMcpConfigPath),
      '--permission-mode', 'acceptEdits',
      '--allowedTools', q((opts.claudeAllowedTools ?? ['mcp__switchboard', 'Bash']).join(',')),
    ];
    if (tuning.model) args.push('--model', q(tuning.model));
    args.push(...(opts.claudeExtraArgs ?? []));
    let env: Record<string, string> | undefined;
    if (tuning.effort) {
      env = { MAX_THINKING_TOKENS: CLAUDE_THINKING_TOKENS[tuning.effort] ?? tuning.effort };
    }
    return { cmd: `${q(opts.claudeCmd)} ${args.join(' ')}`, env };
  }
  if (agent === 'gemini') {
    // agy (Antigravity CLI): the prompt is passed as the value of -p by the launcher
    // (appended as the final spawn argument). MCP access comes from the user's global
    // agy config (once: `agy mcp add switchboard http://localhost:PORT/mcp/gemini`);
    // --dangerously-skip-permissions is what keeps headless board calls from stalling
    // on a permission prompt no human will answer.
    const tuning = merged(opts.geminiTuning);
    // Extra args go FIRST so the built-in flags below win any conflicts
    // (and so a `geminiCmd: node` + extraArgs test shim can carry its script path).
    const args = [
      ...(opts.geminiExtraArgs ?? []),
      '--output-format', 'stream-json',
      '--print-timeout', `${Math.max(1, Math.round(opts.timeoutMs / 1000))}s`,
      '--mode', 'accept-edits',
      '--dangerously-skip-permissions',
    ];
    if (tuning.model) args.push('--model', tuning.model);
    const effort = tuning.effort ? GEMINI_EFFORTS[tuning.effort] : undefined;
    if (effort) args.push('--effort', effort);
    // The launcher appends the prompt as the final spawn argument — it becomes
    // the value of -p (agy rejects bare positional prompts).
    args.push('-p');
    return { cmd: opts.geminiCmd, args };
  }
  if (agent === 'deepseek') {
    // opencode CLI running a DeepSeek model: `opencode run -m deepseek/<model>
    // --format json <prompt>`. The prompt is the trailing positional (the
    // launcher appends it; multiline args survive CreateProcess). The board is
    // wired through a per-run OPENCODE_CONFIG file (remote MCP server), so no
    // global registration is needed. DEEPSEEK_API_KEY must be in the env —
    // Switchboard loads the repo .env at boot for exactly this.
    const tuning = merged(opts.deepseekTuning);
    const args = [
      ...(opts.deepseekExtraArgs ?? []),
      'run',
      '--format', 'json',
      '--auto', // headless: no human to answer permission prompts
    ];
    if (tuning.model) args.push('-m', tuning.model.includes('/') ? tuning.model : `deepseek/${tuning.model}`);
    // no reasoning-effort knob surfaced for deepseek; --variant exists but is unverified for these models
    if (opts.opencodeMcpConfigPath) {
      return { cmd: opts.deepseekCmd, args, env: { OPENCODE_CONFIG: opts.opencodeMcpConfigPath } };
    }
    return { cmd: opts.deepseekCmd, args };
  }
  const tuning = merged(opts.codexTuning);
  const args = ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check'];
  // DeepSeek runs through the Codex CLI's custom-provider support: the
  // [model_providers.deepseek] stanza in ~/.codex/config.toml names the
  // OpenAI-compatible endpoint and reads DEEPSEEK_API_KEY from the env.
  // Its models take no reasoning-effort knob, so that flag is skipped.
  const deepseek = !!tuning.model && /^deepseek/i.test(tuning.model);
  if (tuning.model) args.push('-m', q(tuning.model));
  if (deepseek) {
    args.push('-c', 'model_provider=deepseek');
    // Never ask for approval on a DeepSeek run (the guardian auto-review
    // subagent's helper model is not served by DeepSeek, so its approvals
    // always fail); the workspace-write sandbox still bounds what it touches.
    // Board tools must be "approve" — auto-approve WITHOUT the guardian
    // reviewer. "auto" routes through auto_review and every board call dies
    // with "MCP tool call requires approval, but approval policy is never"
    // (smoke run 94 on codex 0.153.4; "approve" verified working).
    args.push('-c', 'approval_policy=never', '-c', 'mcp_servers.switchboard.default_tools_approval_mode=approve');
  }
  if (tuning.effort && !deepseek) args.push('-c', `model_reasoning_effort=${tuning.effort}`);
  args.push(...(opts.codexExtraArgs ?? []), '-');
  return { cmd: `${q(opts.codexCmd)} ${args.join(' ')}` };
}

const TAIL_LIMIT = 20_000;
const MAX_STDOUT_LINES = 2_000;

/**
 * Pull token usage out of a headless CLI's JSONL output. Tolerant of
 * claude's stream-json (final {"type":"result","usage":{...},"total_cost_usd":n}),
 * codex exec --json event shapes (cumulative usage objects, sometimes nested
 * under info.total_token_usage), agy stream-json (usage under result/step_update),
 * and opencode --format json (part.tokens with input/output + part.cost on
 * step-finish events). The LAST matching usage object wins.
 */
export function extractUsage(lines: string[]): { input: number; output: number; cost: number } {
  let input = 0;
  let output = 0;
  let cost = 0;
  for (const line of lines) {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof obj !== 'object' || obj === null) continue;
    const o = obj as Record<string, any>;
    // agy stream-json: usage sits under the step_update / result event payloads.
    // opencode json: under part.tokens, with snake_case alternatives elsewhere.
    const candidates = [o, o.usage, o.info?.total_token_usage, o.message?.usage, o.result?.usage, o.step_update?.usage, o.part?.tokens];
    for (const c of candidates) {
      const inp = c?.input_tokens ?? c?.input;
      const outp = c?.output_tokens ?? c?.output;
      if (typeof inp === 'number' && typeof outp === 'number') {
        input = inp;
        output = outp;
      }
    }
    if (typeof o.total_cost_usd === 'number') cost = o.total_cost_usd;
    if (typeof o.part?.cost === 'number') cost = o.part.cost;
  }
  return { input, output, cost };
}

const q = (s: string): string => (/[\s()]/.test(s) ? `"${s}"` : s);

export class CliLauncher implements Launcher {
  private readonly authPatterns: { source: string; regex: RegExp }[];
  private readonly authGraceMs: number;

  constructor(private opts: CliLauncherOpts) {
    this.authPatterns = (opts.authPromptPatterns ?? []).map(source => ({ source, regex: new RegExp(source, 'i') }));
    this.authGraceMs = opts.authGraceMs ?? 90_000;
  }

  launch(agent: Agent, prompt: string, cwd: string, onOutput?: (chunk: string) => void, tuning?: AgentTuning, context?: LaunchContext): Promise<RunResult> {
    if (agent === 'nyx') {
      return Promise.resolve({
        ok: false, timedOut: false, exitCode: null,
        outputTail: '[launcher] nyx is HTTP-only; no CLI was spawned',
        inputTokens: 0, outputTokens: 0, costEstimate: 0,
      });
    }
    return new Promise(resolve => {
      const startedAt = Date.now();
      const { cmd, env, args } = buildAgentCommand(agent, this.opts, tuning);
      // Args-array mode (agy): prompt travels as the final spawn argument, no shell —
      // cmd.exe silently mangles multiline quoted arguments.
      const child = args
        ? spawn(cmd, [...args, prompt], { cwd, windowsHide: true, env: { ...process.env, ...this.opts.env, ...env } })
        : spawn(cmd, {
            cwd, shell: true, windowsHide: true,
            env: { ...process.env, ...this.opts.env, ...env },
          });

      let tail = '';
      let stdoutBuf = '';
      const stdoutLines: string[] = [];
      let timedOut = false;
      let settled = false;

      const append = (chunk: Buffer | string) => {
        if (settled) return;
        const text = chunk.toString();
        tail = (tail + text).slice(-TAIL_LIMIT);
        onOutput?.(text);
        if (!timedOut && Date.now() - startedAt < this.authGraceMs) {
          const matched = this.authPatterns.find(pattern => pattern.regex.test(tail));
          if (matched) {
            tail = `[launcher] CLI needs re-login (matched /${matched.source}/): ${tail}`;
            killTree();
            settle(null);
          }
        }
      };

      child.stdout.on('data', (chunk: Buffer) => {
        append(chunk);
        stdoutBuf += chunk.toString();
        let idx;
        while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
          stdoutLines.push(stdoutBuf.slice(0, idx));
          if (stdoutLines.length > MAX_STDOUT_LINES) stdoutLines.shift();
          stdoutBuf = stdoutBuf.slice(idx + 1);
        }
      });
      child.stderr.on('data', append);

      const killTree = () => {
        if (process.platform === 'win32' && child.pid) {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
          killer.on('error', err => append(`[launcher] process termination failed: ${err.message}\n`));
          killer.stderr.on('data', append);
        } else {
          child.kill('SIGKILL');
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, this.opts.timeoutMs);

      const abort = () => { timedOut = true; killTree(); };
      context?.signal?.addEventListener('abort', abort, { once: true });
      if (context?.signal?.aborted) abort();

      const settle = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        context?.signal?.removeEventListener('abort', abort);
        if (stdoutBuf) stdoutLines.push(stdoutBuf);
        const usage = extractUsage(stdoutLines);
        resolve({
          ok: !timedOut && exitCode === 0,
          timedOut,
          exitCode,
          outputTail: tail,
          inputTokens: usage.input,
          outputTokens: usage.output,
          costEstimate: usage.cost,
        });
      };

      child.on('error', err => {
        tail = (tail + `\n[launcher] spawn error: ${err.message}`).slice(-TAIL_LIMIT);
        settle(null);
      });
      child.on('close', code => settle(code));

      // Args-array agents (agy/opencode) take the prompt as an argument; opencode
      // additionally blocks forever if stdin is left open, so always end it.
      child.stdin.on('error', () => { /* process died before reading stdin */ });
      if (!args) child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}

// Kept as a re-export so callers that already import launcher implementations
// from this module can discover the HTTP runner without changing the CLI seam.
export { NyxLauncher } from './nyx-launcher.js';
export type { NyxAgentConfig, NyxLauncherOpts } from './nyx-launcher.js';
