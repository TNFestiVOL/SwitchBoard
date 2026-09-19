import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/store.js';
import { EventBus } from '../src/events.js';
import { Dispatcher } from '../src/dispatcher.js';
import { createApp } from '../src/server.js';
import type { Launcher, RunResult } from '../src/launcher.js';

class IdleLauncher implements Launcher {
  launch(): Promise<RunResult> {
    return new Promise(() => { /* never resolves — keeps runs visible as active */ });
  }
}

describe('server', () => {
  let store: Store;
  let app: ReturnType<typeof createApp>;
  let dispatcher: Dispatcher;
  let httpServer: Server | undefined;

  beforeEach(() => {
    store = new Store(':memory:');
    const bus = new EventBus();
    dispatcher = new Dispatcher(store, new IdleLauncher(), bus, {
      budgets: { claude: { soft: 0, hard: 0 }, codex: { soft: 0, hard: 0 } },
      bounceCap: 6,
    });
    app = createApp({ store, bus, dispatcher });
    store.addProject('staging', 'Z:/Repos/Staging');
  });

  afterEach(() => new Promise<void>(resolve => {
    if (httpServer) httpServer.close(() => resolve());
    else resolve();
    httpServer = undefined;
  }));

  it('renders the board with tasks and columns', async () => {
    store.createTask({ project_id: 1, title: 'Very Visible Task', description: '', assignee: 'human', created_by: 'human', status: 'inbox' });
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<a class="brand" href="/" aria-label="Switchboard home"><img src="/logo.png" alt="Switchboard"></a>');
    expect(res.text).toContain('Very Visible Task');
    expect(res.text).toContain('needs_human');
    expect(res.text).toContain('in_progress');
    // model dropdowns are populated from the hardcoded (config-overridable) choices
    expect(res.text).toContain('<option value="fable"');
    expect(res.text).toContain('<option value="gpt-5.6-luna"');
  });

  it('serves the supplied logo asset', async () => {
    const res = await request(app).get('/logo.png');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^image\/png/);
  });

  it('renders a task page with comments, escaping html', async () => {
    const t = store.createTask({ project_id: 1, title: 'T', description: 'd', assignee: 'human', created_by: 'human', status: 'inbox' });
    store.addComment(t.id, 'codex', '<script>alert(1)</script>');
    const res = await request(app).get(`/task/${t.id}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('&lt;script&gt;');
    expect(res.text).not.toContain('<script>alert');
    expect((await request(app).get('/task/999')).status).toBe(404);
  });

  it('creates projects and tasks over the API, creating the directory if missing', async () => {
    const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const newDir = join(mkdtempSync(join(tmpdir(), 'sb-proj-')), 'brand-new', 'nested');
    expect(existsSync(newDir)).toBe(false);
    const p = await request(app).post('/api/projects').send({ name: 'other', path: newDir });
    expect(p.status).toBe(201);
    expect(existsSync(newDir)).toBe(true);
    rmSync(newDir, { recursive: true, force: true });
    const t = await request(app).post('/api/tasks').send({
      project: 'other', title: 'Api Task', description: 'x', assignee: 'human',
    });
    expect(t.status).toBe(201);
    expect(t.body.status).toBe('inbox');
    const bad = await request(app).post('/api/tasks').send({ project: 'ghost', title: 'x', assignee: 'claude' });
    expect(bad.status).toBe(400);
  });

  it('rejects task creation for workers that are not configured', async () => {
    const bus3 = new EventBus();
    const d3 = new Dispatcher(store, new IdleLauncher(), bus3, { budgets: {}, bounceCap: 6 });
    const app3 = createApp({ store, bus: bus3, dispatcher: d3, workers: new Set(['amber']) });
    const bad = await request(app3).post('/api/tasks').send({ project: 'staging', title: 't', assignee: 'codex', worker_id: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('Unknown worker "nope"');
    const good = await request(app3).post('/api/tasks').send({ project: 'staging', title: 't', assignee: 'codex', worker_id: 'amber' });
    expect(good.status).toBe(201);
  });

  it('supports human comment, assign, status changes', async () => {
    const t = store.createTask({ project_id: 1, title: 'T', description: '', assignee: 'human', created_by: 'human', status: 'inbox' });
    const c = await request(app).post(`/api/tasks/${t.id}/comment`).send({ body: 'hi' });
    expect(c.status).toBe(200);
    expect(store.listComments(t.id)[0].author).toBe('human');
    const a = await request(app).post(`/api/tasks/${t.id}/assign`).send({ assignee: 'human' });
    expect(a.body.status).toBe('needs_human');
    const s = await request(app).post(`/api/tasks/${t.id}/status`).send({ status: 'done' });
    expect(s.body.status).toBe('done');
    expect((await request(app).post(`/api/tasks/${t.id}/status`).send({ status: 'nope' })).status).toBe(400);
  });

  it('creates a planning task via /api/plan with tuning and the planner brief', async () => {
    const res = await request(app).post('/api/plan').send({
      project: 'staging', goal: 'Build a snake game with tests', planner: 'claude', model: 'opus', effort: 'max',
    });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Plan: Build a snake game with tests');
    expect(res.body.assignee).toBe('claude');
    expect(res.body.model).toBe('opus');
    expect(res.body.effort).toBe('max');
    expect(res.body.description).toContain('Build a snake game with tests');
    expect(res.body.description).toContain('PLANNER BRIEF');
    expect(res.body.description).toContain('create_task');
    expect(res.body.description).toContain('"staging"');
    expect((await request(app).post('/api/plan').send({ project: 'staging', goal: 'x', planner: 'gemini' })).status).toBe(400);
    expect((await request(app).post('/api/plan').send({ project: 'staging', goal: '  ', planner: 'claude' })).status).toBe(400);
  });

  it('plan in draft mode instructs draft task creation', async () => {
    const res = await request(app).post('/api/plan').send({
      project: 'staging', goal: 'Refactor the parser', planner: 'codex', draft: 'on',
    });
    expect(res.status).toBe(201);
    expect(res.body.description).toContain('DRAFT MODE');
    expect(res.body.description).toContain('draft: true');
    const normal = await request(app).post('/api/plan').send({ project: 'staging', goal: 'x', planner: 'codex' });
    expect(normal.body.description).not.toContain('DRAFT MODE');
  });

  it('blocks release and hides the button while a planner is in flight', async () => {
    store.createTask({ project_id: 1, title: 'draft x', description: '', assignee: 'codex', created_by: 'claude', status: 'inbox' });
    store.createTask({ project_id: 1, title: 'Plan: something big', description: '', assignee: 'claude', created_by: 'human', status: 'in_progress' });
    const rel = await request(app).post('/api/tasks/release');
    expect(rel.status).toBe(409);
    const board = await request(app).get('/');
    expect(board.text).not.toContain('Release 1 draft');
    expect(board.text).toContain('planner still creating tasks');
    // planner finishes → release unlocks
    const plan = store.listTasks().find(t => t.title.startsWith('Plan:'))!;
    store.updateTask(plan.id, { status: 'review' });
    expect((await request(app).post('/api/tasks/release')).body.released).toBe(1);
  });

  it('releases agent-assigned inbox drafts to ready, leaving human tasks parked', async () => {
    store.createTask({ project_id: 1, title: 'draft a', description: '', assignee: 'codex', created_by: 'codex', status: 'inbox' });
    store.createTask({ project_id: 1, title: 'draft b', description: '', assignee: 'claude', created_by: 'codex', status: 'inbox' });
    store.createTask({ project_id: 1, title: 'for me', description: '', assignee: 'human', created_by: 'human', status: 'inbox' });
    const res = await request(app).post('/api/tasks/release');
    expect(res.body.released).toBe(2);
    const stillInbox = store.listTasks({ status: 'inbox' });
    expect(stillInbox).toHaveLength(1);
    expect(stillInbox[0].assignee).toBe('human');
    // released tasks are now dispatchable (one is already claimed by the idle launcher)
    expect(store.listTasks().filter(t => t.status === 'ready' || t.status === 'in_progress')).toHaveLength(2);
  });

  it('updates agent tuning in memory and persists it', async () => {
    const saved: string[] = [];
    const agentInfo = { claude: {}, codex: { model: 'old' } };
    const bus2 = new EventBus();
    const d2 = new Dispatcher(store, new IdleLauncher(), bus2, {
      budgets: { claude: { soft: 0, hard: 0 }, codex: { soft: 0, hard: 0 } }, bounceCap: 6,
    });
    const app2 = createApp({ store, bus: bus2, dispatcher: d2, agentInfo, persistTuning: () => saved.push('saved') });
    const res = await request(app2).post('/api/tuning').send({ agent: 'claude', model: 'opus', effort: 'high' });
    expect(res.status).toBe(200);
    expect(agentInfo.claude).toEqual({ model: 'opus', effort: 'high' });
    expect(saved).toEqual(['saved']);
    // clearing back to defaults removes keys
    await request(app2).post('/api/tuning').send({ agent: 'codex', model: '', effort: '' });
    expect(agentInfo.codex).toEqual({});
    const state = await request(app2).get('/api/state');
    expect(state.body.agents.claude.model).toBe('opus');
    expect((await request(app2).post('/api/tuning').send({ agent: 'gemini', model: 'gemini-3.1-pro-high' })).status).toBe(200);
    const tunedState = await request(app2).get('/api/state');
    expect(tunedState.body.agents.gemini.model).toBe('gemini-3.1-pro-high');
    expect((await request(app2).post('/api/tuning').send({ agent: 'bogus', model: 'x' })).status).toBe(400);
  });

  it('pauses and resumes dispatch', async () => {
    await request(app).post('/api/pause');
    expect(store.getSetting('paused', '0')).toBe('1');
    await request(app).post('/api/resume');
    expect(store.getSetting('paused', '0')).toBe('0');
  });

  it('reports state with budgets and active runs', async () => {
    store.createTask({ project_id: 1, title: 'Run me', description: '', assignee: 'claude', created_by: 'human', status: 'ready' });
    dispatcher.tick();
    const res = await request(app).get('/api/state');
    expect(res.body.paused).toBe(false);
    expect(res.body.projects).toHaveLength(1);
    expect(res.body.tasks).toHaveLength(1);
    expect(res.body.budgets.claude.level).toBe('ok');
    expect(res.body.activeRuns).toHaveLength(1);
  });

  it('serves live run output', async () => {
    store.createTask({ project_id: 1, title: 'Run me', description: '', assignee: 'claude', created_by: 'human', status: 'ready' });
    dispatcher.tick();
    const runId = dispatcher.activeRuns()[0].runId;
    const res = await request(app).get(`/api/runs/${runId}/output`);
    expect(res.status).toBe(200);
    expect(typeof res.body.output).toBe('string');
    expect((await request(app).get('/api/runs/999/output')).status).toBe(404);
  });

  it('speaks MCP on /mcp/:agent with connection-derived identity', async () => {
    await new Promise<void>(resolve => {
      httpServer = app.listen(0, () => resolve());
    });
    const port = (httpServer!.address() as { port: number }).port;
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/claude`)));
    const tools = await client.listTools();
    expect(tools.tools.map(t => t.name).sort()).toEqual([
      'add_comment', 'assign_task', 'claim_task', 'create_task',
      'finish_task', 'get_task', 'list_tasks', 'update_status',
    ]);
    const result = await client.callTool({
      name: 'create_task',
      arguments: { project: 'staging', title: 'From MCP', assignee: 'codex' },
    });
    const created = JSON.parse((result.content as { text: string }[])[0].text);
    expect(created.created_by).toBe('claude');
    expect(created.status).toBe('ready'); // snapshot at creation; dispatcher picks it up right after
    expect(store.getTask(created.id)!.status).toBe('in_progress'); // ...and indeed it did
    await client.close();

    const bad = await fetch(`http://127.0.0.1:${port}/mcp/impostor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(bad.status).toBe(404);
  });
});
