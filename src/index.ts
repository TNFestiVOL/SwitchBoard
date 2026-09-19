import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig, resolveWorkerTokens, saveTuning } from './config.js';
import { Store } from './store.js';
import { EventBus } from './events.js';
import { CliLauncher } from './launcher.js';
import { NyxLauncher } from './nyx-launcher.js';
import { AgentLauncher } from './agent-launcher.js';
import { Dispatcher } from './dispatcher.js';
import { createApp } from './server.js';
import { scanClaudeTranscripts } from './claude-usage.js';
import { PlanUsageTracker } from './plan-usage.js';
import { WorktreeManager } from './worktrees.js';
import { RemoteCoordinator } from './remote.js';

const root = process.cwd();
const config = loadConfig(root);

// Load the repo .env (if present) into the environment WITHOUT overriding real
// env vars. Spawned agents inherit these — DEEPSEEK_API_KEY for the deepseek
// agent (opencode) and the codex custom-provider branch both depend on it.
try {
  for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch { /* no .env — fine */ }

mkdirSync(dirname(config.dbPath), { recursive: true });

// MCP config file handed to headless `claude -p` runs so they can reach this board.
const claudeMcpConfigPath = join(dirname(config.dbPath), 'claude-mcp.json');
writeFileSync(claudeMcpConfigPath, JSON.stringify({
  mcpServers: {
    switchboard: { type: 'http', url: `http://127.0.0.1:${config.port}/mcp/claude` },
  },
}, null, 2));

// opencode config file handed to deepseek runs via OPENCODE_CONFIG (per-run, no
// global registration): one remote MCP server pointing at the board.
const opencodeMcpConfigPath = join(dirname(config.dbPath), 'opencode-mcp.json');
writeFileSync(opencodeMcpConfigPath, JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  mcp: {
    switchboard: {
      type: 'remote',
      url: `http://127.0.0.1:${config.port}/mcp/deepseek`,
      enabled: true,
    },
  },
}, null, 2));

const store = new Store(config.dbPath);
const bus = new EventBus();
const cliLauncher = new CliLauncher({
  claudeCmd: config.claudeCmd,
  codexCmd: config.codexCmd,
  geminiCmd: config.geminiCmd,
  deepseekCmd: config.deepseekCmd,
  claudeMcpConfigPath,
  opencodeMcpConfigPath,
  timeoutMs: config.timeoutMs,
  claudeExtraArgs: config.claudeExtraArgs,
  codexExtraArgs: config.codexExtraArgs,
  geminiExtraArgs: config.geminiExtraArgs,
  deepseekExtraArgs: config.deepseekExtraArgs,
  claudeTuning: config.tuning.claude,
  codexTuning: config.tuning.codex,
  geminiTuning: config.tuning.gemini,
  deepseekTuning: config.tuning.deepseek,
  claudeAllowedTools: config.claudeAllowedTools,
});
const launcher = new AgentLauncher(
  cliLauncher,
  new NyxLauncher({ ...config.agents.nyx, timeoutMs: config.timeoutMs }),
);
const planTracker = new PlanUsageTracker({
  claudeCredentialsPath: config.claudeCredentialsPath,
  codexSessionsDir: config.codexSessionsDir,
  agyCmd: config.geminiCmd,
});
const dispatcher = new Dispatcher(store, launcher, bus, {
  budgets: config.budgets,
  bounceCap: config.bounceCap,
  extraClaudeTokens: () => scanClaudeTranscripts(config.claudeProjectsDir),
  planTracker,
  planMaxPercent: config.planMaxPercent,
  parallel: config.parallelWorktrees,
  worktrees: new WorktreeManager(join(dirname(config.dbPath), 'worktrees')),
  agentConcurrency: config.agentConcurrency,
});

void planTracker.refresh().then(() => bus.change({ kind: 'plan_refreshed' }));
setInterval(() => {
  void planTracker.refresh().then(() => bus.change({ kind: 'plan_refreshed' }));
}, config.planRefreshMs);

dispatcher.recoverOrphans({ remoteEnabled: !!config.remote });

const workerTokens = config.remote ? resolveWorkerTokens(config.remote.tokenEnv) : { tokens: {}, problems: [] };
for (const problem of workerTokens.problems) console.warn(`[remote] ${problem}`);
if (config.remote) {
  const remote = new RemoteCoordinator(store, bus, dispatcher, { tokens: workerTokens.tokens, bounceCap: config.bounceCap });
  remote.expire();
  setInterval(() => remote.expire(), 5000);
  remote.app.listen(config.remote.port, config.remote.host ?? '0.0.0.0', () => console.log(`Worker listener on port ${config.remote!.port}`));
}

// Persist tuning changes from the UI back into switchboard.config.json,
// preserving whatever else the user has in there.
const configPath = join(root, 'switchboard.config.json');

const machines = (config.machines ?? [{ workerId: null, name: 'This PC', ip: '127.0.0.1' }]).map(pc => ({
  ...pc,
  configured: pc.workerId === null || Object.hasOwn(workerTokens.tokens, pc.workerId),
}));
const app = createApp({
  store, bus, dispatcher, agentInfo: config.tuning, modelChoices: config.modelChoices, machines,
  persistTuning: () => saveTuning(configPath, config.tuning),
  workers: new Set(Object.keys(workerTokens.tokens)),
});
app.listen(config.port, '0.0.0.0', () => {
  console.log(`
  Switchboard is up.

    Board UI      http://localhost:${config.port}/
    Claude MCP    http://localhost:${config.port}/mcp/claude
    Codex MCP     http://localhost:${config.port}/mcp/codex
    Gemini MCP    http://localhost:${config.port}/mcp/gemini
    DeepSeek MCP  http://localhost:${config.port}/mcp/deepseek
    Human MCP     http://localhost:${config.port}/mcp/human

  Register once per CLI:
    claude mcp add --transport http switchboard http://localhost:${config.port}/mcp/claude
    codex mcp add switchboard --url http://localhost:${config.port}/mcp/codex
    agy mcp add switchboard http://localhost:${config.port}/mcp/gemini
    deepseek: no registration needed (Switchboard injects OPENCODE_CONFIG per run)
`);
});

setInterval(() => dispatcher.tick(), config.sweepMs);
