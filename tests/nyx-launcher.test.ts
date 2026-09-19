import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Store } from '../src/store.js';
import { EventBus } from '../src/events.js';
import { Dispatcher } from '../src/dispatcher.js';
import { NyxLauncher } from '../src/nyx-launcher.js';

interface RequestRecord {
  method: string;
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown> | null;
}

const servers: Server[] = [];

const startMockNyx = async (statuses: Record<string, unknown>[]) => {
  const requests: RequestRecord[] = [];
  let statusIndex = 0;
  let nextId = 1;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const body = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : null;
      requests.push({
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        authorization: req.headers.authorization,
        body,
      });

      if (req.method === 'POST' && req.url === '/coding/tasks') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'mock-' + nextId++ }));
        return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/coding/tasks/')) {
        const status = statuses[Math.min(statusIndex++, statuses.length - 1)];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(status));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: 'not found' }));
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as { port: number };
  return {
    url: 'http://127.0.0.1:' + address.port,
    requests,
  };
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe('NyxLauncher', () => {
  it('posts the card, streams transcript deltas, and stops at ready_for_review', async () => {
    const mock = await startMockNyx([
      { id: 'nyx-1', status: 'running', transcript: [{ step: 1, action: 'plan' }] },
      { id: 'nyx-1', status: 'ready_for_review', transcript: [{ step: 1, action: 'plan' }, { step: 2, action: 'done' }] },
    ]);
    const chunks: string[] = [];
    const result = await new NyxLauncher({
      url: mock.url,
      token: 'test-token',
      timeoutMs: 2_000,
      pollIntervalMs: 1,
    }).launch(
      'nyx',
      'unused prompt',
      'C:/run/worktree',
      chunk => chunks.push(chunk),
      undefined,
      { task: { title: 'Card title', description: 'Card description' }, baseBranch: 'main' },
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.outputTail).toContain('"action":"plan"');
    expect(result.outputTail).toContain('"action":"done"');
    expect(chunks.join('')).toBe(result.outputTail);
    expect(mock.requests.map(request => request.method + ' ' + request.path)).toEqual([
      'POST /coding/tasks',
      'GET /coding/tasks/mock-1',
      'GET /coding/tasks/mock-1',
    ]);
    expect(mock.requests[0].authorization).toBe('Bearer test-token');
    expect(mock.requests[0].body).toEqual({
      task: 'Card title\n\nCard description',
      workspace_path: 'C:/run/worktree',
      base_branch: 'main',
    });
  });

  it('does not call Nyx publish/confirm endpoints', async () => {
    const mock = await startMockNyx([
      { status: 'ready_for_review', transcript: [] },
    ]);
    await new NyxLauncher({ url: mock.url, timeoutMs: 2_000, pollIntervalMs: 1 }).launch(
      'nyx',
      '',
      'C:/run/worktree',
      undefined,
      undefined,
      { task: { title: 'No push', description: '' }, baseBranch: 'main' },
    );
    expect(mock.requests.every(request => request.path === '/coding/tasks' || request.path.startsWith('/coding/tasks/mock-'))).toBe(true);
    expect(mock.requests.some(request => request.path.endsWith('/confirm'))).toBe(false);
  });
});

describe('Dispatcher with NyxLauncher', () => {
  it('moves a nyx card to review when Nyx reaches ready_for_review', async () => {
    const mock = await startMockNyx([{ status: 'ready_for_review', transcript: [{ step: 1, action: 'tests_passed' }] }]);
    const store = new Store(':memory:');
    const bus = new EventBus();
    const project = store.addProject('demo', process.cwd());
    const task = store.createTask({
      project_id: project.id,
      title: 'Implement the feature',
      description: 'Run the focused tests.',
      assignee: 'nyx',
      created_by: 'human',
      status: 'ready',
    });
    const dispatcher = new Dispatcher(store, new NyxLauncher({
      url: mock.url,
      timeoutMs: 2_000,
      pollIntervalMs: 1,
    }), bus, {
      budgets: { nyx: { soft: 0, hard: 0 } },
      bounceCap: 6,
    });

    dispatcher.tick();
    const deadline = Date.now() + 2_000;
    while (store.getTask(task.id)?.status === 'in_progress' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    expect(store.getTask(task.id)?.status).toBe('review');
    expect(store.listRuns(task.id)[0].agent).toBe('nyx');
    expect(store.listRuns(task.id)[0].status).toBe('succeeded');
    expect(mock.requests[0].body).toMatchObject({
      task: 'Implement the feature\n\nRun the focused tests.',
      workspace_path: process.cwd(),
      base_branch: 'main',
    });
  });

  it('surfaces Nyx failure and transcript tail as needs_human', async () => {
    const mock = await startMockNyx([{
      status: 'failed',
      error: 'Nyx stopped after a failed test',
      transcript: [{ step: 4, action: 'run_tests', output: 'TRANSCRIPT_TAIL_MARKER' }],
    }]);
    const store = new Store(':memory:');
    const bus = new EventBus();
    const project = store.addProject('demo', process.cwd());
    const task = store.createTask({
      project_id: project.id,
      title: 'Failing feature',
      description: '',
      assignee: 'nyx',
      created_by: 'human',
      status: 'ready',
    });
    const dispatcher = new Dispatcher(store, new NyxLauncher({
      url: mock.url,
      timeoutMs: 2_000,
      pollIntervalMs: 1,
    }), bus, {
      budgets: { nyx: { soft: 0, hard: 0 } },
      bounceCap: 6,
    });

    dispatcher.tick();
    const deadline = Date.now() + 2_000;
    while (store.getTask(task.id)?.status === 'in_progress' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    expect(store.getTask(task.id)?.status).toBe('needs_human');
    expect(store.listRuns(task.id)[0].status).toBe('failed');
    expect(store.listRuns(task.id)[0].output_tail).toContain('TRANSCRIPT_TAIL_MARKER');
    expect(store.listComments(task.id).some(comment => comment.body.includes('TRANSCRIPT_TAIL_MARKER'))).toBe(true);
  });
});
