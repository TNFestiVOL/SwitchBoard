import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { CliLauncher, buildAgentCommand, extractUsage, type CliLauncherOpts } from '../src/launcher.js';

const baseOpts: CliLauncherOpts = {
  claudeCmd: 'claude', codexCmd: 'codex', geminiCmd: 'agy', deepseekCmd: 'opencode',
  claudeMcpConfigPath: 'data/claude-mcp.json', timeoutMs: 1000,
};

describe('buildAgentCommand', () => {
  it('applies claude model and effort tuning', () => {
    const { cmd, env } = buildAgentCommand('claude', {
      ...baseOpts, claudeTuning: { model: 'opus', effort: 'high' },
    });
    expect(cmd).toContain('--model opus');
    expect(env).toEqual({ MAX_THINKING_TOKENS: '32000' });
    expect(cmd).toContain('--mcp-config data/claude-mcp.json');
    expect(cmd).toContain('--allowedTools mcp__switchboard,Bash'); // agents must be able to run tests
    const scoped = buildAgentCommand('claude', { ...baseOpts, claudeAllowedTools: ['mcp__switchboard', 'Bash(npm test:*)'] });
    expect(scoped.cmd).toContain('--allowedTools "mcp__switchboard,Bash(npm test:*)"'); // parens need cmd.exe quoting
  });

  it('applies codex model and reasoning effort', () => {
    const { cmd, env } = buildAgentCommand('codex', {
      ...baseOpts, codexTuning: { model: 'gpt-5.6-luna', effort: 'high' },
    });
    expect(cmd).toContain('-m gpt-5.6-luna');
    expect(cmd).toContain('-c model_reasoning_effort=high');
    expect(cmd.trim().endsWith('-')).toBe(true); // stdin prompt marker stays last
    expect(env).toBeUndefined();
  });

  it('routes deepseek models through the custom provider and drops the effort knob', () => {
    const { cmd } = buildAgentCommand('codex', {
      ...baseOpts, codexTuning: { model: 'deepseek-chat', effort: 'xhigh' },
    });
    expect(cmd).toContain('-m deepseek-chat');
    expect(cmd).toContain('-c model_provider=deepseek');
    expect(cmd).toContain('-c approval_policy=never');
    // "approve" (not "auto") — auto routes through the guardian reviewer, whose
    // helper model doesn't exist on DeepSeek's API.
    expect(cmd).toContain('-c mcp_servers.switchboard.default_tools_approval_mode=approve');
    expect(cmd).not.toContain('model_reasoning_effort');
    expect(cmd.trim().endsWith('-')).toBe(true);
    const plain = buildAgentCommand('codex', { ...baseOpts, codexTuning: { model: 'gpt-5.6-luna', effort: 'high' } });
    expect(plain.cmd).not.toContain('model_provider');
    expect(plain.cmd).not.toContain('approval_policy');
  });

  it('adds no tuning flags by default and passes numeric claude effort through', () => {
    expect(buildAgentCommand('claude', baseOpts).cmd).not.toContain('--model');
    expect(buildAgentCommand('codex', baseOpts).cmd).not.toContain('model_reasoning_effort');
    expect(buildAgentCommand('claude', { ...baseOpts, claudeTuning: { effort: '12345' } }).env)
      .toEqual({ MAX_THINKING_TOKENS: '12345' });
  });

  it('lets a per-task override beat the configured default', () => {
    const opts = { ...baseOpts, claudeTuning: { model: 'sonnet', effort: 'low' } };
    const { cmd, env } = buildAgentCommand('claude', opts, { model: 'opus', effort: 'max' });
    expect(cmd).toContain('--model opus');
    expect(env).toEqual({ MAX_THINKING_TOKENS: '63999' });
    // partial override: only effort — model falls back to the default
    const partial = buildAgentCommand('claude', opts, { effort: 'high' });
    expect(partial.cmd).toContain('--model sonnet');
    expect(partial.env).toEqual({ MAX_THINKING_TOKENS: '32000' });
  });

  it('maps the full claude effort ladder to thinking budgets', () => {
    const budget = (effort: string) =>
      buildAgentCommand('claude', { ...baseOpts, claudeTuning: { effort } }).env!.MAX_THINKING_TOKENS;
    expect(budget('off')).toBe('0');
    expect(budget('xhigh')).toBe('48000');
    expect(budget('max')).toBe('63999');
  });

  it('builds an args-array command for gemini with print timeout and clamped effort', () => {
    const base = buildAgentCommand('gemini', { ...baseOpts, geminiCmd: 'agy' });
    expect(base.cmd).toBe('agy');
    // the trailing -p receives the prompt as its value (appended by the launcher)
    expect(base.args).toEqual([
      '--output-format', 'stream-json',
      '--print-timeout', '1s', // timeoutMs 1000
      '--mode', 'accept-edits',
      '--dangerously-skip-permissions',
      '-p',
    ]);
    const withExtra = buildAgentCommand('gemini', { ...baseOpts, geminiExtraArgs: ['--custom'] });
    expect(withExtra.args![0]).toBe('--custom'); // extras go first; built-ins win conflicts
    const tuned = buildAgentCommand('gemini', {
      ...baseOpts, geminiCmd: 'agy', geminiTuning: { model: 'gemini-3.1-pro-high', effort: 'xhigh' },
    }, { effort: 'off' });
    expect(tuned.args).toContain('--model');
    expect(tuned.args).toContain('gemini-3.1-pro-high');
    // per-task override wins and clamps onto agy's low|medium|high ladder
    const effortAt = tuned.args!.indexOf('--effort');
    expect(tuned.args![effortAt + 1]).toBe('low');
    const defaultEffort = buildAgentCommand('gemini', {
      ...baseOpts, geminiTuning: { effort: 'xhigh' },
    });
    const idx = defaultEffort.args!.indexOf('--effort');
    expect(defaultEffort.args![idx + 1]).toBe('high');
    const unknown = buildAgentCommand('gemini', { ...baseOpts, geminiTuning: { effort: 'banana' } });
    expect(unknown.args).not.toContain('--effort');
  });

  it('refuses to build commands for nyx', () => {
    expect(() => buildAgentCommand('nyx', baseOpts)).toThrow(/HTTP-only/);
  });

  it('builds an args-array command for deepseek with provider-prefixed model', () => {
    const base = buildAgentCommand('deepseek', { ...baseOpts, deepseekCmd: 'opencode' });
    expect(base.cmd).toBe('opencode');
    expect(base.args).toEqual(['run', '--format', 'json', '--auto']);
    const tuned = buildAgentCommand('deepseek', {
      ...baseOpts, deepseekTuning: { model: 'deepseek-v4-pro' },
    });
    const mAt = tuned.args!.indexOf('-m');
    expect(tuned.args![mAt + 1]).toBe('deepseek/deepseek-v4-pro'); // provider prefix added
    const pre = buildAgentCommand('deepseek', {
      ...baseOpts, deepseekTuning: { model: 'openrouter/deepseek/deepseek-chat' },
    });
    const pAt = pre.args!.indexOf('-m');
    expect(pre.args![pAt + 1]).toBe('openrouter/deepseek/deepseek-chat'); // already prefixed — untouched
    // per-run board wiring via OPENCODE_CONFIG instead of global registration
    const wired = buildAgentCommand('deepseek', { ...baseOpts, opencodeMcpConfigPath: 'data/opencode-mcp.json' });
    expect(wired.env).toEqual({ OPENCODE_CONFIG: 'data/opencode-mcp.json' });
    const noModel = buildAgentCommand('deepseek', baseOpts);
    expect(noModel.args).not.toContain('-m'); // opencode's own default model when unset
  });
});

const fakeCli = join(process.cwd(), 'tests', 'fixtures', 'fake-cli.mjs');
const fakeAgy = join(process.cwd(), 'tests', 'fixtures', 'fake-agy.mjs');
const fakeOpencode = join(process.cwd(), 'tests', 'fixtures', 'fake-opencode.mjs');

const launcher = (mode: string, timeoutMs = 10_000, opts: Partial<CliLauncherOpts> = {}) => new CliLauncher({
  claudeCmd: `node ${fakeCli} ${mode}`,
  codexCmd: `node ${fakeCli} ${mode}`,
  geminiCmd: 'agy',
  deepseekCmd: 'opencode',
  claudeMcpConfigPath: 'unused.json',
  timeoutMs,
  rawCommands: true, // test hook: use cmd string verbatim, no default args
  ...opts,
});

const authOpts = {
  authPromptPatterns: ['please (run|use) [^\\n]*login'],
  authGraceMs: 90_000,
};

describe('extractUsage', () => {
  it('reads claude result-line usage and cost', () => {
    const lines = [
      '{"type":"system","subtype":"init"}',
      'plain text noise',
      '{"type":"result","total_cost_usd":0.12,"usage":{"input_tokens":900,"output_tokens":400}}',
    ];
    expect(extractUsage(lines)).toEqual({ input: 900, output: 400, cost: 0.12 });
  });

  it('takes the LAST cumulative usage from codex-style events', () => {
    const lines = [
      '{"type":"turn.completed","usage":{"input_tokens":50,"output_tokens":20}}',
      '{"type":"turn.completed","usage":{"input_tokens":80,"output_tokens":35}}',
    ];
    expect(extractUsage(lines)).toEqual({ input: 80, output: 35, cost: 0 });
  });

  it('recognizes nested info.total_token_usage and ignores junk', () => {
    const lines = [
      'garbage {',
      '{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"output_tokens":4}}}',
    ];
    expect(extractUsage(lines)).toEqual({ input: 10, output: 4, cost: 0 });
  });

  it('returns zeros when nothing matches', () => {
    expect(extractUsage(['{"a":1}'])).toEqual({ input: 0, output: 0, cost: 0 });
  });

  it('reads agy stream-json usage from step_update and the final result event', () => {
    const lines = [
      '{"event":"init","conversation_id":"x"}',
      '{"event":"step_update","step_update":{"state":"DONE","usage":{"input_tokens":5,"output_tokens":2}}}',
      '{"event":"result","result":{"status":"SUCCESS","usage":{"input_tokens":11,"output_tokens":7}}}',
    ];
    // LAST cumulative usage wins — the result event, not the intermediate step.
    expect(extractUsage(lines)).toEqual({ input: 11, output: 7, cost: 0 });
  });

  it('reads opencode part.tokens usage and part.cost from step-finish events', () => {
    const lines = [
      '{"type":"step_start"}',
      '{"type":"step_finish","part":{"type":"step-finish","tokens":{"total":9,"input":21,"output":5},"cost":0.000123}}',
      '{"type":"step_finish","part":{"type":"step-finish","tokens":{"total":14,"input":100,"output":12},"cost":0.000208}}',
    ];
    expect(extractUsage(lines)).toEqual({ input: 100, output: 12, cost: 0.000208 });
  });
});

describe('CliLauncher', () => {
  it('fails fast on an early re-login prompt for every CLI agent', async () => {
    const cmd = `node ${fakeCli} auth-prompt`;
    const instance = launcher('auth-prompt', 30_000, { ...authOpts, geminiCmd: cmd, deepseekCmd: cmd });
    const started = Date.now();
    const results = await Promise.all((['claude', 'codex', 'gemini', 'deepseek'] as const)
      .map(agent => instance.launch(agent, 'x', process.cwd())));
    expect(Date.now() - started).toBeLessThan(3_000);
    for (const result of results) {
      expect(result).toMatchObject({ ok: false, timedOut: false, exitCode: null });
      expect(result.outputTail.startsWith(`[launcher] CLI needs re-login (matched /${authOpts.authPromptPatterns[0]}/): `)).toBe(true);
      expect(result.outputTail).toContain('Please run /login to continue');
    }
  }, 5_000);

  it('detects a re-login prompt split across output streams', async () => {
    const chunks: string[] = [];
    const result = await launcher('auth-prompt 0 split', 30_000, authOpts)
      .launch('claude', 'x', process.cwd(), chunk => chunks.push(chunk));
    expect(result).toMatchObject({ ok: false, timedOut: false, exitCode: null });
    expect(result.outputTail).toBe(`[launcher] CLI needs re-login (matched /${authOpts.authPromptPatterns[0]}/): Please run /login to continue\n`);
    expect(chunks.join('')).toBe('Please run /login to continue\n');
  }, 5_000);

  it('lets a re-login prompt after the grace window run to normal completion', async () => {
    const started = Date.now();
    const result = await launcher('auth-prompt 100', 30_000, { ...authOpts, authGraceMs: 1 })
      .launch('claude', 'x', process.cwd());
    expect(Date.now() - started).toBeGreaterThanOrEqual(20_000);
    expect(result).toMatchObject({ ok: true, timedOut: false, exitCode: 0 });
    expect(result.outputTail).toBe('Please run /login to continue\n');
  }, 30_000);

  it('preserves normal success with re-login detection enabled', async () => {
    const result = await launcher('ok', 10_000, authOpts).launch('claude', 'x', process.cwd());
    expect(result).toMatchObject({ ok: true, timedOut: false, exitCode: 0, inputTokens: 900, outputTokens: 400 });
    expect(result.outputTail).not.toContain('[launcher] CLI needs re-login');
  });

  it('runs to success, parses usage, streams output', async () => {
    const chunks: string[] = [];
    const result = await launcher('ok').launch('claude', 'do the thing', process.cwd(), c => chunks.push(c));
    expect(result.ok).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.inputTokens).toBe(900);
    expect(result.outputTokens).toBe(400);
    expect(result.costEstimate).toBe(0.12);
    expect(result.outputTail).toContain('"type":"result"');
    expect(result.outputTail).toContain('read 12 bytes of prompt'); // stderr captured too
    expect(chunks.join('')).toContain('working...');
  });

  it('reports failure exit codes', async () => {
    const result = await launcher('fail').launch('codex', 'x', process.cwd());
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.outputTail).toContain('something exploded');
  });

  it('kills and flags on timeout', async () => {
    const result = await launcher('hang', 500).launch('claude', 'x', process.cwd());
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
  }, 15_000);

  it('spawns gemini without a shell, prompt as the final argument', async () => {
    const gemini = new CliLauncher({
      claudeCmd: 'claude', codexCmd: 'codex', geminiCmd: 'node', deepseekCmd: 'opencode', claudeMcpConfigPath: 'unused.json',
      geminiExtraArgs: [fakeAgy],
      timeoutMs: 10_000,
    });
    const prompt = 'Line one.\nLine two.\nFinish the job.';
    const chunks: string[] = [];
    const result = await gemini.launch('gemini', prompt, process.cwd(), c => chunks.push(c));
    expect(result.ok).toBe(true);
    expect(result.inputTokens).toBe(11);
    expect(result.outputTokens).toBe(7);
    expect(chunks.join('')).toContain('"event":"result"');
    // The fake echoes its last argv, proving the multiline prompt arrived intact.
    expect(result.outputTail).toContain(`got prompt: ${prompt}`);
  });

  it('spawns deepseek without a shell, prompt as the final positional', async () => {
    const deepseek = new CliLauncher({
      claudeCmd: 'claude', codexCmd: 'codex', geminiCmd: 'agy', deepseekCmd: 'node', claudeMcpConfigPath: 'unused.json',
      deepseekExtraArgs: [fakeOpencode], opencodeMcpConfigPath: 'unused-opencode.json',
      timeoutMs: 10_000,
    });
    const prompt = 'Line one.\nLine two.\nDeepseek, do the job.';
    const chunks: string[] = [];
    const result = await deepseek.launch('deepseek', prompt, process.cwd(), c => chunks.push(c));
    expect(result.ok).toBe(true);
    expect(result.inputTokens).toBe(21);
    expect(result.outputTokens).toBe(5);
    expect(result.costEstimate).toBeCloseTo(0.000123);
    expect(chunks.join('')).toContain('step_finish');
    // The fake echoes its last argv, proving the multiline prompt arrived intact.
    expect(result.outputTail).toContain(`got prompt: ${prompt}`);
  });
});
