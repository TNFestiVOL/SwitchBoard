import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { loadConfig, resolveWorkerTokens, saveTuning } from './config.js';
import { Store } from './store.js';
import { EventBus } from './events.js';
import { CliLauncher } from './launcher.js';
import { NyxLauncher } from './nyx-launcher.js';
import { AgentLauncher } from './agent-launcher.js';
import { Dispatcher } from './dispatcher.js';
import { attachListenerFailure, createApp } from './server.js';
import { scanClaudeTranscripts } from './claude-usage.js';
import { PlanUsageTracker } from './plan-usage.js';
import { WorktreeManager } from './worktrees.js';
import { RemoteCoordinator } from './remote.js';

const root = process.cwd();
const bootId = randomUUID();
const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
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

const operatorPassword = process.env[config.operatorPasswordEnv];
if (!operatorPassword) console.warn('operator password not set; board is open to the LAN');

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
  authPromptPatterns: config.authPromptPatterns,
  authGraceMs: config.authGraceMs,
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
const planRefreshInterval = setInterval(() => {
  void planTracker.refresh().then(() => bus.change({ kind: 'plan_refreshed' }));
}, config.planRefreshMs);

dispatcher.recoverOrphans({ remoteEnabled: !!config.remote });

const workerTokens = config.remote ? resolveWorkerTokens(config.remote.tokenEnv) : { tokens: {}, problems: [] };
for (const problem of workerTokens.problems) console.warn(`[remote] ${problem}`);
let remoteExpireInterval: ReturnType<typeof setInterval> | undefined;
const remoteServer = (() => {
  if (!config.remote) return;
  const remote = new RemoteCoordinator(store, bus, dispatcher, { tokens: workerTokens.tokens, bounceCap: config.bounceCap });
  remote.expire();
  remoteExpireInterval = setInterval(() => remote.expire(), 5000);
  return remote.app.listen(config.remote.port, config.remote.host ?? '0.0.0.0', () => console.log(`Worker listener on port ${config.remote!.port}`));
})();
if (remoteServer) attachListenerFailure(remoteServer, `worker port ${config.remote!.port}`);

// Persist tuning changes from the UI back into switchboard.config.json,
// preserving whatever else the user has in there.
const configPath = join(root, 'switchboard.config.json');

const machines = (config.machines ?? [{ workerId: null, name: 'This PC', ip: '127.0.0.1' }]).map(pc => ({
  ...pc,
  configured: pc.workerId === null || Object.hasOwn(workerTokens.tokens, pc.workerId),
}));
const app = createApp({
  store, bus, dispatcher, agentInfo: config.tuning, modelChoices: config.modelChoices, machines,
  operatorPassword,
  shutdown,
  persistTuning: () => saveTuning(configPath, config.tuning),
  workers: new Set(Object.keys(workerTokens.tokens)),
  readiness: () => config.remote && !remoteServer?.listening
    ? { ok: false, reason: `worker listener on ${config.remote.port} is not bound` }
    : { ok: true },
  info: { version, bootId },
});
const boardServer = app.listen(config.port, config.bindHost, () => {
  console.log(`
  Switchboard is up.

    Board UI      http://${config.bindHost.includes(':') ? `[${config.bindHost}]` : config.bindHost}:${config.port}/
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

attachListenerFailure(boardServer, `board port ${config.port}`);
const dispatcherSweepInterval = setInterval(() => dispatcher.tick(), config.sweepMs);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(dispatcherSweepInterval);
  clearInterval(planRefreshInterval);
  if (remoteExpireInterval) clearInterval(remoteExpireInterval);
  await Promise.all([boardServer, remoteServer].map(server => {
    if (!server) return;
    return new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }));
  store.close();
  process.exit(0);
}

process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
