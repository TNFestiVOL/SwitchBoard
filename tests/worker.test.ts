import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store.js';
import { EventBus } from '../src/events.js';
import { Dispatcher } from '../src/dispatcher.js';
import { RemoteCoordinator, type WorkOrder } from '../src/remote.js';
import { RemoteWorker } from '../src/worker.js';
import { CliLauncher } from '../src/launcher.js';

const servers: Server[] = [], stores: Store[] = [], directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const store of stores.splice(0)) store.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup(opts: { networkFailure?: boolean; rejectLaunch?: boolean; exitFailures?: number; expire?: boolean; abortOnStart?: AbortController } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sb-worker-')); directories.push(dir);
  const script = join(dir, 'child.cjs');
  writeFileSync(script, `const fs = require('node:fs');
console.log('started');
setTimeout(() => { fs.writeFileSync('closed.txt', 'exited'); process.exit(7); }, 100);
`);
  const store = new Store(':memory:'); stores.push(store);
  const bus = new EventBus();
  const dispatcher = new Dispatcher(store, { launch: async () => { throw new Error('unexpected local launch'); } }, bus, { budgets: {}, bounceCap: 6 });
  const project = store.addProject('demo', dir);
  const task = store.createTask({ project_id: project.id, title: 'work', description: '', assignee: 'codex', created_by: 'human', status: 'ready', worker_id: 'alpha' });
  const token = 'a'.repeat(64);
  let now = Date.now(), returnedAt: number | undefined, claimed: WorkOrder | undefined;
  const coordinator = new RemoteCoordinator(store, bus, dispatcher, { tokens: { alpha: token }, bounceCap: 6, now: () => now, leaseMs: 2000 });
  const reports: { body: any; token: string | undefined; afterReturn: boolean; receivedAt: number }[] = [];
  const completions: any[] = [];
  let exitFailures = opts.exitFailures ?? 0;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.path.endsWith('/complete')) {
      completions.push(req.body);
      if (opts.networkFailure) { req.socket.destroy(); return; }
    }
    if (req.path.endsWith('/exited')) {
      reports.push({ body: req.body, token: req.get('x-run-token'), afterReturn: returnedAt !== undefined, receivedAt: Date.now() });
      if (exitFailures-- > 0) { res.sendStatus(503); return; }
    }
    next();
  });
  app.use(coordinator.app);
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const worker = new RemoteWorker({
    id: 'alpha', token, boardUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    agents: ['codex'], projects: { demo: dir }, completeRetryMs: [1, 1],
    launcher: order => {
      claimed = order;
      if (opts.rejectLaunch) {
        now += 3000; coordinator.expire();
        return { launch: async () => { throw new Error('launch failed'); } };
      }
      const cli = new CliLauncher({ rawCommands: true, codexCmd: `node "${script}"`, claudeCmd: '', geminiCmd: '', deepseekCmd: '', claudeMcpConfigPath: '', timeoutMs: 5000 });
      return { launch: async (agent, prompt, cwd, output, tuning, context) => {
        const result = await cli.launch(agent, prompt, cwd, chunk => {
          output?.(chunk);
          if (opts.expire !== false && chunk.includes('started')) { now += 3000; coordinator.expire(); }
          if (chunk.includes('started')) opts.abortOnStart?.abort();
        }, tuning, context);
        returnedAt = Date.now();
        return result;
      } };
    },
  });
  return { worker, store, task, dir, reports, completions, order: () => claimed!, returnedAt: () => returnedAt! };
}

describe('remote worker exit evidence', () => {
  it('sends one authenticated exited report after the real child closes and completion retries end in 409', async () => {
    const s = await setup();
    await expect(s.worker.once()).rejects.toThrow('HTTP 409');
    expect(readFileSync(join(s.dir, 'closed.txt'), 'utf8')).toBe('exited');
    expect(s.completions).toHaveLength(3);
    expect(s.reports).toHaveLength(1);
    expect(s.reports[0]).toMatchObject({ token: s.order().token, afterReturn: true, body: { exitCode: 7 } });
    const exitedAt = Date.parse(s.reports[0].body.exitedAt);
    expect(exitedAt).toBeGreaterThanOrEqual(s.returnedAt());
    expect(exitedAt).toBeLessThanOrEqual(s.reports[0].receivedAt);
    expect(s.store.getRun(s.order().runId)).toMatchObject({ status: 'failed', reconciled_by: 'worker:alpha' });
    expect(s.store.getLease(s.order().runId)?.state).toBe('lost');
    expect(s.store.getTask(s.task.id)?.status).toBe('needs_human');
  });

  it('does not send exited evidence after completion network failures', async () => {
    const s = await setup({ networkFailure: true });
    await expect(s.worker.once()).rejects.toThrow(/fetch failed/);
    expect(readFileSync(join(s.dir, 'closed.txt'), 'utf8')).toBe('exited');
    expect(s.completions).toHaveLength(3);
    expect(s.reports).toEqual([]);
    expect(s.store.getRun(s.order().runId)?.reconciled_at).toBeNull();
  });

  it('reports a null exit code for an aborted child only after launch returns', async () => {
    const controller = new AbortController();
    const s = await setup({ abortOnStart: controller });
    await expect(s.worker.once(controller.signal)).rejects.toThrow('HTTP 409');
    expect(s.reports).toHaveLength(1);
    expect(s.reports[0]).toMatchObject({ afterReturn: true, body: { exitCode: null } });
    expect(s.completions[0]).toMatchObject({ ok: false, timedOut: true, exitCode: null });
  });

  it('retries the same exit evidence and logs failures without replacing the completion error', async () => {
    const s = await setup({ exitFailures: 3 });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(s.worker.once()).rejects.toThrow('HTTP 409');
    expect(s.reports).toHaveLength(3);
    expect(s.reports.every(report => report.afterReturn && report.body.exitedAt === s.reports[0].body.exitedAt)).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('HTTP 503'));
    expect(s.store.getRun(s.order().runId)?.reconciled_at).toBeNull();
  });

  it('does not claim exit evidence when the launcher never returned a result', async () => {
    const s = await setup({ rejectLaunch: true });
    await expect(s.worker.once()).rejects.toThrow('HTTP 409');
    expect(s.reports).toEqual([]);
  });
});

describe('remote worker git metadata', () => {
  it('collects HEAD and dirty files from the mapped git work tree after the real child exits', async () => {
    const s = await setup({ expire: false });
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args], { cwd: s.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init');
    writeFileSync(join(s.dir, 'tracked.txt'), 'before');
    git('add', '-A'); git('commit', '-m', 'initial');
    const headSha = git('rev-parse', 'HEAD');
    writeFileSync(join(s.dir, 'tracked.txt'), 'after');
    expect(await s.worker.once()).toBe(true);
    expect(readFileSync(join(s.dir, 'closed.txt'), 'utf8')).toBe('exited');
    expect(s.completions).toHaveLength(1);
    expect(s.completions[0]).toMatchObject({ headSha, dirtyFiles: 2 });
    expect(git('status', '--porcelain').split(/\r?\n/)).toHaveLength(2);
    expect(s.store.listComments(s.task.id).at(-1)?.body).toContain(` HEAD ${headSha.slice(0, 7)} with 2 uncommitted file(s) on that PC.`);
  });

  it('omits git metadata for a non-git project directory', async () => {
    const s = await setup({ expire: false });
    expect(await s.worker.once()).toBe(true);
    expect(s.completions[0]).not.toHaveProperty('headSha');
    expect(s.completions[0]).not.toHaveProperty('dirtyFiles');
  });

  it('omits both metadata fields when the git work tree has no HEAD', async () => {
    const s = await setup({ expire: false });
    execFileSync('git', ['init'], { cwd: s.dir, stdio: 'pipe' });
    expect(await s.worker.once()).toBe(true);
    expect(s.completions[0]).not.toHaveProperty('headSha');
    expect(s.completions[0]).not.toHaveProperty('dirtyFiles');
  });
});
