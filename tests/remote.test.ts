import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store.js';
import { Dispatcher } from '../src/dispatcher.js';
import { EventBus } from '../src/events.js';
import { RemoteCoordinator } from '../src/remote.js';
import { RemoteWorker } from '../src/worker.js';
import { CliLauncher } from '../src/launcher.js';
import { toolHandlers } from '../src/tools.js';

const tokenA = 'a'.repeat(64), tokenB = 'b'.repeat(64);
const result = { ok: true, timedOut: false, exitCode: 0, outputTail: 'done', inputTokens: 1, outputTokens: 2, costEstimate: 0 };
const stores: Store[] = [], servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const store of stores.splice(0)) store.close();
});
function setup() {
  const store = new Store(':memory:'); stores.push(store);
  const bus = new EventBus();
  let localLaunches = 0, now = Date.now();
  const dispatcher = new Dispatcher(store, { launch: async () => { localLaunches++; return result; } }, bus, { budgets: {}, bounceCap: 6 });
  const coordinator = new RemoteCoordinator(store, bus, dispatcher, { tokens: { alpha: tokenA, beta: tokenB }, bounceCap: 6, now: () => now, leaseMs: 2000 });
  store.addProject('demo', process.cwd());
  const h = toolHandlers(store, bus, 'human');
  const task = (worker = 'alpha', deps: number[] = []) => h.create_task({ project: 'demo', title: 'remote test', assignee: 'codex', worker_id: worker, depends_on: deps });
  const claim = (worker = 'alpha', token = tokenA) => request(coordinator.app).post(`/workers/${worker}/claim`).auth(token, { type: 'bearer' }).send({ agents: ['codex'], projects: ['demo'] });
  const finish = (order: any, worker = 'alpha', token = tokenA) => request(coordinator.app).post(`/workers/${worker}/runs/${order.runId}/complete`).auth(token, { type: 'bearer' }).set('x-run-token', order.token).send(result);
  return { store, bus, coordinator, task, claim, finish, dispatcher, localLaunches: () => localLaunches, advance: () => { now += 3000; } };
}

describe('remote coordinator', () => {
  it('emits changes for dispatch but stays quiet on idle and busy polls', async () => {
    const s = setup(); const events: string[] = [];
    s.bus.onChange(e => events.push(e.kind));
    await s.claim(); await s.claim();
    expect(events).toEqual([]);
    s.task(); events.length = 0;
    await s.claim();
    expect(events).toEqual(['remote_dispatch_changed']);
    events.length = 0;
    await s.claim();
    expect(events).toEqual([]);
  });
  it('authenticates workers and never routes remote tasks to the local launcher', async () => {
    const s = setup(); s.task();
    expect((await s.claim('alpha', 'bad')).status).toBe(401);
    expect((await s.claim('beta', tokenB)).body).toBeNull();
    expect((await s.claim()).body.task.worker_id).toBe('alpha');
    expect(s.localLaunches()).toBe(0);
  });
  it('leases once, fences other workers, and accepts completion retries once', async () => {
    const s = setup(); const t = s.task();
    const orders = await Promise.all([s.claim(), s.claim()]);
    const order = orders.find(r => r.body !== null)!.body;
    expect(orders.filter(r => r.body !== null)).toHaveLength(1);
    expect((await s.finish(order, 'beta', tokenB)).status).toBe(403);
    expect((await s.finish(order)).status).toBe(200);
    expect((await s.finish(order)).status).toBe(200);
    expect(s.store.listComments(t.id)).toHaveLength(1);
    expect(s.store.getTask(t.id)?.status).toBe('review');
  });
  it('parks expired leases, rejects late writes and never automatically retries', async () => {
    const s = setup(); const t = s.task(); const order = (await s.claim()).body;
    s.advance(); s.coordinator.expire();
    expect(s.store.getTask(t.id)?.status).toBe('needs_human');
    expect((await s.finish(order)).status).toBe(409);
    expect((await s.claim()).body).toBeNull();
  });
  it('renews leases and keeps remote runs out of local restart recovery', async () => {
    const s = setup(); s.task(); const order = (await s.claim()).body;
    s.dispatcher.recoverOrphans();
    expect(s.store.runningRuns()).toHaveLength(1);
    const r = await request(s.coordinator.app).post(`/workers/alpha/runs/${order.runId}/heartbeat`).auth(tokenA, { type: 'bearer' }).set('x-run-token', order.token).send({ output: 'live' });
    expect(r.status).toBe(200);
    expect(s.store.getRun(order.runId)?.output_tail).toBe('live');
  });
  it('holds cross-PC dependencies for explicit artifact-transfer approval', async () => {
    const s = setup(); const parent = s.task(); s.task('beta', [parent.id]);
    await s.finish((await s.claim()).body);
    expect((await s.claim('beta', tokenB)).body).toBeNull();
    s.store.updateTask(parent.id, { status: 'done' });
    expect((await s.claim('beta', tokenB)).body.task.worker_id).toBe('beta');
  });
  it('respects pause and missing local project mappings', async () => {
    const s = setup(); s.task(); s.store.setSetting('paused', '1');
    expect((await s.claim()).body).toBeNull();
    s.store.setSetting('paused', '0');
    const res = await request(s.coordinator.app).post('/workers/alpha/claim').auth(tokenA, { type: 'bearer' }).send({ agents: ['codex'], projects: ['wrong'] });
    expect(res.body).toBeNull();
  });
  it('does not expose the human API on the worker listener', async () => {
    const s = setup();
    expect((await request(s.coordinator.app).post('/api/tasks').send({})).status).toBe(404);
    expect((await request(s.coordinator.app).post('/mcp/human').send({})).status).toBe(404);
  });
  it('rejects prototype property names as worker ids instead of crashing', async () => {
    const s = setup();
    for (const id of ['constructor', '__proto__', 'toString']) {
      expect((await s.claim(id, tokenA)).status).toBe(401);
    }
  });
  it('leaves a human-set status alone when a remote run succeeds', async () => {
    const s = setup(); const t = s.task(); const order = (await s.claim()).body;
    toolHandlers(s.store, s.bus, 'human').update_status({ id: t.id, status: 'done' });
    expect((await s.finish(order)).status).toBe(200);
    expect(s.store.getTask(t.id)?.status).toBe('done');
    expect(s.store.listComments(t.id).at(-1)?.body).toContain('finished');
  });
});

it('runs two real child processes in separate worker directories and reports through scoped MCP', async () => {
  const s = setup(); const a = s.task(), b = s.task('beta');
  const server = s.coordinator.app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const dirs = [mkdtempSync(join(tmpdir(), 'sb-alpha-')), mkdtempSync(join(tmpdir(), 'sb-beta-'))];
  const fixture = join(process.cwd(), 'tests', 'fixtures', 'remote-agent.mjs');
  const workers = ['alpha', 'beta'].map((id, i) => new RemoteWorker({
    id, token: i ? tokenB : tokenA, boardUrl: url, agents: ['codex'], projects: { demo: dirs[i] },
    launcher: order => new CliLauncher({
      rawCommands: true, codexCmd: `node "${fixture}"`, claudeCmd: '', geminiCmd: '', deepseekCmd: '', claudeMcpConfigPath: '', timeoutMs: 10_000,
      env: { TEST_MCP_URL: `${url}/runs/${order.runId}/mcp`, SWITCHBOARD_RUN_TOKEN: order.token },
    }),
  }));
  expect(await Promise.all(workers.map(w => w.once()))).toEqual([true, true]);
  for (const [i, task] of [a, b].entries()) {
    expect(s.store.getTask(task.id)?.status).toBe('review');
    expect(readFileSync(join(dirs[i], 'switchboard-smoke.txt'), 'utf8')).toContain(`Task ${task.id} executed in ${dirs[i]}`);
    expect(s.store.listComments(task.id).some(c => c.body.includes('MCP round trip verified'))).toBe(true);
  }
  expect(existsSync(join(process.cwd(), 'switchboard-smoke.txt'))).toBe(false);
}, 15_000);

it('keeps the lease alive and retries a failed completion instead of losing the result', async () => {
  const s = setup(); const t = s.task();
  let failures = 1;
  // A one-shot 503 on /complete stands in for a board blip; the worker must retry, not give up.
  const outer = express();
  outer.use((req, res, next) => {
    if (req.path.endsWith('/complete') && failures > 0) { failures--; res.sendStatus(503); }
    else next();
  });
  outer.use(s.coordinator.app);
  const server = outer.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const worker = new RemoteWorker({
    boardUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, id: 'alpha', token: tokenA,
    agents: ['codex'], projects: { demo: process.cwd() },
    launcher: () => ({ launch: async () => result }), completeRetryMs: [10, 10],
  });
  expect(await worker.once()).toBe(true);
  expect(failures).toBe(0);
  expect(s.store.getTask(t.id)?.status).toBe('review');
});
