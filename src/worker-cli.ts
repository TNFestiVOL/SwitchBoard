import { readFileSync, writeFileSync, mkdirSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { RemoteWorker } from './worker.js';
import { CliLauncher } from './launcher.js';
import { loadConfig } from './config.js';

const schema = z.object({
  boardUrl: z.string().url(), id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).default('SWITCHBOARD_WORKER_TOKEN'),
  agents: z.array(z.enum(['claude', 'codex'])).min(1),
  projects: z.record(z.string()).refine(p => Object.keys(p).length > 0),
  pollMs: z.number().int().min(100).optional(),
});

export async function workerMain(configPath: string, once = false): Promise<void> {
  const cfg = schema.parse(JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')));
  const origin = new URL(cfg.boardUrl);
  if (!/^https?:$/.test(origin.protocol) || !/^[a-zA-Z0-9.:-]+$/.test(origin.hostname) || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error('boardUrl must be an http(s) origin with no path or credentials');
  }
  const token = process.env[cfg.tokenEnv] ?? '';
  const root = dirname(resolve(configPath));
  const defaults = loadConfig(root);
  const dataDir = join(root, 'data', `worker-${cfg.id}`);
  mkdirSync(dataDir, { recursive: true });
  const lock = join(dataDir, 'worker.lock');
  // Never steal a stale lock: the earlier agent process might still be editing files.
  const fd = openSync(lock, 'wx');
  writeFileSync(fd, String(process.pid));
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const worker = new RemoteWorker({
      ...cfg, token,
      launcher: order => {
        for (const value of [order.task.model, order.task.effort]) {
          if (value && !/^[a-zA-Z0-9_.:/-]+$/.test(value)) throw new Error('Invalid remote model/effort override');
        }
        const url = `${origin.origin}/runs/${order.runId}/mcp`;
        const mcpPath = join(dataDir, `mcp-${order.runId}.json`);
        writeFileSync(mcpPath, JSON.stringify({ mcpServers: { switchboard: { type: 'http', url, headers: { Authorization: `Bearer ${order.token}` } } } }), { mode: 0o600 });
        return new CliLauncher({
          ...defaults,
          claudeMcpConfigPath: mcpPath,
          claudeExtraArgs: [...defaults.claudeExtraArgs, '--strict-mcp-config'],
          codexExtraArgs: [...defaults.codexExtraArgs,
            '-c', `mcp_servers.switchboard.url=${url}`,
            '-c', 'mcp_servers.switchboard.bearer_token_env_var=SWITCHBOARD_RUN_TOKEN',
            '-c', 'mcp_servers.switchboard.enabled=true',
            '-c', 'mcp_servers.switchboard.default_tools_approval_mode=approve'],
          claudeTuning: defaults.tuning.claude, codexTuning: defaults.tuning.codex,
          env: { [cfg.tokenEnv]: undefined, SWITCHBOARD_RUN_TOKEN: order.token },
        });
      },
      cleanup: order => { try { unlinkSync(join(dataDir, `mcp-${order.runId}.json`)); } catch { /* already absent */ } },
    });
    console.log(`Worker ${cfg.id} connecting to ${origin.origin}; projects: ${Object.keys(cfg.projects).join(', ')}`);
    if (once) await worker.once(controller.signal);
    else await worker.run(controller.signal);
  } finally {
    closeSync(fd);
    unlinkSync(lock);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void workerMain(resolve(process.argv[2] ?? 'worker.config.json'), process.argv.includes('--once')).catch(err => {
    console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1;
  });
}
