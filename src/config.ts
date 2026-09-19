import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AGENTS, type Agent } from './types.js';
import type { AgentTuning } from './launcher.js';
import type { NyxAgentConfig } from './nyx-launcher.js';

export interface Config {
  machines?: { workerId: string | null; name: string; ip: string }[];
  remote?: { host?: string; port: number; tokenEnv: Record<string, string> };
  port: number;
  dbPath: string;
  bounceCap: number;
  timeoutMs: number;
  sweepMs: number;
  budgets: Record<Agent, { soft: number; hard: number }>;
  claudeCmd: string;
  codexCmd: string;
  geminiCmd: string;
  deepseekCmd: string;
  claudeExtraArgs: string[];
  codexExtraArgs: string[];
  geminiExtraArgs: string[];
  deepseekExtraArgs: string[];
  claudeProjectsDir: string;
  claudeCredentialsPath: string;
  codexSessionsDir: string;
  planMaxPercent: Record<Agent, number>;
  planRefreshMs: number;
  tuning: Record<Agent, AgentTuning>;
  /** Model dropdown options in the UI. Edit here when vendors rename their lineup. */
  modelChoices: Record<Agent, string[]>;
  /** Tools headless claude may use without prompting. Bash is included so agents can run tests;
   *  remove it (or scope it, e.g. "Bash(npm test:*)") for a tighter posture. */
  claudeAllowedTools: string[];
  /** Let both agents work the same git project simultaneously, each in its own worktree. */
  parallelWorktrees: boolean;
  /** Concurrent runs per agent (default 1 each). e.g. { "codex": 2 } spawns two codex instances. */
  agentConcurrency: Record<Agent, number>;
  agents: { nyx: NyxAgentConfig };
}

export function saveTuning(configPath: string, tuning: Config['tuning']): void {
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error('switchboard.config.json is not valid JSON; tuning not saved');
    }
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
    throw new Error('switchboard.config.json must contain a JSON object; tuning not saved');
  }
  existing.tuning = tuning;
  writeFileSync(configPath + '.tmp', JSON.stringify(existing, null, 2) + '\n');
  renameSync(configPath + '.tmp', configPath);
}

/** Resolve worker credentials from the environment. Missing or short tokens are reported, never fatal. */
export function resolveWorkerTokens(
  tokenEnv: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): { tokens: Record<string, string>; problems: string[] } {
  const tokens: Record<string, string> = {};
  const problems: string[] = [];
  for (const [workerId, name] of Object.entries(tokenEnv)) {
    const value = env[name] ?? '';
    if (!value) problems.push(`worker "${workerId}": ${name} is not set; that PC stays "setup needed" until it is`);
    else if (value.length < 32) problems.push(`worker "${workerId}": ${name} must be at least 32 characters (got ${value.length}); ignored`);
    else tokens[workerId] = value;
  }
  return { tokens, problems };
}

// Claude entries are official CLI aliases that always point at the LATEST of each family
// (verified via `claude --help`); `fable` targets the newest Fable (5.1 on Claude Code
// 2.1.260 — a pinned "fable-5.1" id is rejected by that version's model catalog). Codex has
// no aliases, so those are current model names; "gpt-6-astra" requires codex > 0.150.1
// (server returns "requires a newer version of Codex" on older CLIs). DeepSeek names run
// through the Codex CLI's custom-provider branch (launcher.ts) with the approval workarounds
// applied there. Gemini entries are agy (Antigravity CLI) model ids — run `agy models` for
// the live list; override any list via modelChoices in config.
export const DEFAULT_MODEL_CHOICES: Record<Agent, string[]> = {
  claude: ['fable', 'opus', 'sonnet', 'haiku'],
  codex: ['gpt-6-astra', 'gpt-5.6-luna', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat'],
  // Local Ollama models the coding limb can pin per card; override with modelChoices.nyx in switchboard.config.json.
  nyx: ['nyx-gemma4-12b-64k', 'qwen3-coder:latest'],
  gemini: ['gemini-3.1-pro-high', 'gemini-3.1-pro-low', 'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low'],
  // opencode direct-provider ids (`opencode models`); dispatched as deepseek/<id>.
  deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash'],
};

/** A record with an entry for every agent — keeps defaults complete as AGENTS grows. */
const perAgent = <T>(value: T): Record<Agent, T> =>
  Object.fromEntries(AGENTS.map(a => [a, value])) as Record<Agent, T>;

const defaults = (root: string): Config => ({
  port: 4680,
  dbPath: join(root, 'data', 'switchboard.db'),
  bounceCap: 6,
  timeoutMs: 15 * 60_000,
  sweepMs: 15_000,
  budgets: perAgent({ soft: 0, hard: 0 }),
  claudeCmd: 'claude',
  codexCmd: 'codex',
  geminiCmd: 'agy',
  deepseekCmd: 'opencode',
  claudeExtraArgs: [],
  codexExtraArgs: [],
  geminiExtraArgs: [],
  deepseekExtraArgs: [],
  claudeProjectsDir: join(homedir(), '.claude', 'projects'),
  claudeCredentialsPath: join(homedir(), '.claude', '.credentials.json'),
  codexSessionsDir: join(homedir(), '.codex', 'sessions'),
  planMaxPercent: perAgent(0),
  planRefreshMs: 5 * 60_000,
  tuning: perAgent({}),
  modelChoices: {
    claude: [...DEFAULT_MODEL_CHOICES.claude],
    codex: [...DEFAULT_MODEL_CHOICES.codex],
    nyx: [],
    gemini: [...DEFAULT_MODEL_CHOICES.gemini],
    deepseek: [...DEFAULT_MODEL_CHOICES.deepseek],
  },
  claudeAllowedTools: ['mcp__switchboard', 'Bash'],
  parallelWorktrees: false,
  agentConcurrency: perAgent(1),
  agents: { nyx: { url: '', token: '' } },
});

/** Defaults, shallow-merged with optional switchboard.config.json (budgets deep-merged). */
export function loadConfig(root: string): Config {
  const base = defaults(root);
  let overrides: Partial<Config> & {
    budgets?: Partial<Record<Agent, Partial<{ soft: number; hard: number }>>>;
    planMaxPercent?: Partial<Record<Agent, number>>;
    tuning?: Partial<Record<Agent, AgentTuning>>;
    modelChoices?: Partial<Record<Agent, string[]>>;
    agentConcurrency?: Partial<Record<Agent, number>>;
    agents?: { nyx?: Partial<NyxAgentConfig> };
  } = {};
  try {
    overrides = JSON.parse(readFileSync(join(root, 'switchboard.config.json'), 'utf8'));
  } catch {
    return base;
  }
  const merged: Config = {
    ...base, ...overrides,
    budgets: { ...base.budgets }, planMaxPercent: { ...base.planMaxPercent }, tuning: perAgent({}),
    modelChoices: { ...base.modelChoices },
    agentConcurrency: { ...base.agentConcurrency },
    agents: { nyx: { ...base.agents.nyx, ...(overrides.agents?.nyx ?? {}) } },
  } as Config;
  for (const agent of AGENTS) {
    merged.budgets[agent] = { ...base.budgets[agent], ...(overrides.budgets?.[agent] ?? {}) };
    if (typeof overrides.planMaxPercent?.[agent] === 'number') merged.planMaxPercent[agent] = overrides.planMaxPercent[agent]!;
    merged.tuning[agent] = { ...(overrides.tuning?.[agent] ?? {}) };
    if (Array.isArray(overrides.modelChoices?.[agent])) merged.modelChoices[agent] = overrides.modelChoices[agent]!;
    if (typeof overrides.agentConcurrency?.[agent] === 'number') merged.agentConcurrency[agent] = overrides.agentConcurrency[agent]!;
  }
  return merged;
}
