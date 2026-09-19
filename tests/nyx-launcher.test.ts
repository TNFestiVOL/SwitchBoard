import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Store } from '../src/store.js';
import { EventBus } from '../src/events.js';
import { Dispatcher } from '../src/dispatcher.js';
import { NyxLauncher, type NyxLauncherOpts } from '../src/nyx-launcher.js';

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

describe('timeout cancellation', () => {
  type Handler = (init: RequestInit) => Response | Promise<Response>;

  const mockFetch = (handlers: { create?: Handler; poll?: Handler; cancel?: Handler; confirm?: Handler } = {}) => {
    let cancelRequested = false;
    return vi.fn<typeof fetch>(async (input, init = {}) => {
      const path = new URL(String(input)).pathname;
      if (path === '/coding/tasks') {
        return handlers.create?.(init) ?? Response.json({ id: 'task/1' });
      }
      if (path.endsWith('/cancel')) {
        cancelRequested = true;
        return handlers.cancel?.(init) ?? Response.json({ status: 'cancelling' }, { status: 202 });
      }
      if (cancelRequested) {
        return handlers.confirm?.(init) ?? Response.json({ status: 'cancelled' });
      }
      return handlers.poll?.(init) ?? Response.json({ status: 'running', transcript: 'working' });
    });
  };

  const waitForAbort: Handler = init => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(new DOMException('request aborted', 'AbortError')), { once: true });
  });

  const launch = (fetchFn: typeof fetch, opts: Partial<NyxLauncherOpts> = {}, onOutput?: (chunk: string) => void) =>
    new NyxLauncher({
      url: 'http://nyx.test/', token: 'test-token', timeoutMs: 20, pollIntervalMs: 5,
      cancelGraceMs: 30, fetchFn, ...opts,
    }).launch('nyx', 'task', 'C:/run/worktree', onOutput);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it('cancels once with the timeout reason and auth, then waits for cancelled', async () => {
    let confirmations = 0;
    const fetchFn = mockFetch({
      confirm: () => Response.json({
        status: ++confirmations === 1 ? 'cancelling' : 'cancelled',
        transcript: confirmations === 1 ? 'working' : 'working\nended',
      }),
    });
    const chunks: string[] = [];
    const run = launch(fetchFn, {}, chunk => chunks.push(chunk));
    await vi.advanceTimersByTimeAsync(50);
    const result = await run;

    expect(result).toMatchObject({ ok: false, timedOut: true, exitCode: null });
    expect(result).not.toHaveProperty('uncertain');
    expect(result.outputTail).toContain('[nyx] cancelled after timeout; terminal status: cancelled');
    expect(result.outputTail.match(/working/g)).toHaveLength(1);
    expect(result.outputTail).toContain('ended');
    expect(chunks.join('')).toBe(result.outputTail);
    const cancelCalls = fetchFn.mock.calls.filter(([url]) => String(url).endsWith('/cancel'));
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0][0]).toBe('http://nyx.test/coding/tasks/task%2F1/cancel');
    expect(cancelCalls[0][1]?.method).toBe('POST');
    expect(JSON.parse(String(cancelCalls[0][1]?.body))).toEqual({ reason: 'Switchboard run timed out after 20 ms' });
    expect(new Headers(cancelCalls[0][1]?.headers).get('content-type')).toBe('application/json');
    expect(fetchFn.mock.calls.every(([, init]) => new Headers(init?.headers).get('authorization') === 'Bearer test-token')).toBe(true);
    expect(fetchFn.mock.calls.slice(-3).map(([url, init]) => `${init?.method} ${url}`)).toEqual([
      'POST http://nyx.test/coding/tasks/task%2F1/cancel',
      'GET http://nyx.test/coding/tasks/task%2F1',
      'GET http://nyx.test/coding/tasks/task%2F1',
    ]);
  });

  it('reports uncertainty when cancelling outlasts the grace period', async () => {
    const fetchFn = mockFetch({ confirm: () => Response.json({ status: 'cancelling' }) });
    const run = launch(fetchFn);
    await vi.advanceTimersByTimeAsync(50);
    const result = await run;

    expect(result).toMatchObject({ ok: false, timedOut: true, exitCode: null });
    expect(result.uncertain).toBe('Nyx accepted the cancel but reported no terminal status within 30 ms (last: cancelling); the job may still be running');
    expect(result.outputTail.trimEnd()).toContain(result.uncertain);
  });

  it.each([404, 405])('reports an older cancel endpoint on HTTP %i without further polling', async status => {
    const fetchFn = mockFetch({ cancel: () => Response.json({ detail: 'not found' }, { status }) });
    const run = launch(fetchFn);
    await vi.advanceTimersByTimeAsync(50);
    const result = await run;

    expect(result.uncertain).toBe('Nyx has no cancel endpoint (older build); the job may still be running');
    expect(result.outputTail).toContain(result.uncertain);
    expect(String(fetchFn.mock.lastCall?.[0])).toMatch(/\/cancel$/);
  });

  it('reports uncertainty when the cancel request throws', async () => {
    const fetchFn = mockFetch({ cancel: () => { throw new Error('network unavailable'); } });
    const run = launch(fetchFn);
    await vi.advanceTimersByTimeAsync(50);
    const result = await run;

    expect(result.uncertain).toBe('cancel request failed: network unavailable; the job may still be running');
    expect(result.outputTail).toContain(result.uncertain);
    expect(String(fetchFn.mock.lastCall?.[0])).toMatch(/\/cancel$/);
  });

  it.each([204, 500])('reports a failed cancel request for unexpected HTTP %i', async status => {
    const fetchFn = mockFetch({ cancel: () => new Response(null, { status }) });
    const run = launch(fetchFn);
    await vi.advanceTimersByTimeAsync(50);
    const result = await run;

    expect(result.uncertain).toContain('cancel request failed:');
    expect(result.uncertain).toContain(`HTTP ${status}`);
    expect(result.uncertain).toContain('the job may still be running');
    expect(result.outputTail).toContain(result.uncertain);
  });

  it('never cancels a normal ready_for_review run', async () => {
    const fetchFn = mockFetch({ poll: () => Response.json({ status: 'ready_for_review' }) });
    const result = await launch(fetchFn);

    expect(result).toMatchObject({ ok: true, timedOut: false, exitCode: 0 });
    expect(result).not.toHaveProperty('uncertain');
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls.some(([url]) => String(url).endsWith('/cancel'))).toBe(false);
  });

  it('does not cancel when create times out before returning an id', async () => {
    const fetchFn = mockFetch({ create: waitForAbort });
    const run = launch(fetchFn);
    await vi.advanceTimersByTimeAsync(20);
    const result = await run;

    expect(result).toMatchObject({ ok: false, timedOut: true, exitCode: null });
    expect(result).not.toHaveProperty('uncertain');
    expect(result.outputTail).toContain('[nyx] Nyx request timed out');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('cancels after an in-flight status poll aborts', async () => {
    const fetchFn = mockFetch({ poll: waitForAbort });
    const run = launch(fetchFn);
    await vi.advanceTimersByTimeAsync(50);
    const result = await run;

    expect(result).toMatchObject({ ok: false, timedOut: true, exitCode: null });
    expect(result).not.toHaveProperty('uncertain');
    expect(result.outputTail).toContain('terminal status: cancelled');
    expect(fetchFn.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'GET', 'POST', 'GET']);
  });

  it.each(['cancelled', 'stopped', 'failed', 'interrupted', 'ready_for_review', 'published'])(
    'confirms terminal status %s after a 200 cancel response', async status => {
      const fetchFn = mockFetch({
        cancel: () => Response.json({ status }, { status: 200 }),
        confirm: () => Response.json({ status }),
      });
      const run = launch(fetchFn);
      await vi.advanceTimersByTimeAsync(50);
      const result = await run;

      expect(result).toMatchObject({ ok: false, timedOut: true, exitCode: null });
      expect(result).not.toHaveProperty('uncertain');
      expect(result.outputTail).toContain(`terminal status: ${status}`);
      expect(fetchFn.mock.lastCall?.[1]?.method).toBe('GET');
    },
  );

  it('bounds the cancel request itself by the grace deadline', async () => {
    const fetchFn = mockFetch({ cancel: waitForAbort });
    const run = launch(fetchFn);
    await vi.advanceTimersByTimeAsync(50);
    const result = await run;

    expect(result.uncertain).toBe('cancel request failed: Nyx request timed out; the job may still be running');
    expect(result.outputTail).toContain(result.uncertain);
    expect(String(fetchFn.mock.lastCall?.[0])).toMatch(/\/cancel$/);
  });

  it('shares one grace deadline between cancel and confirmation', async () => {
    let confirmationAbortedAt: number | undefined;
    const fetchFn = mockFetch({
      cancel: () => new Promise(resolve => setTimeout(() => resolve(Response.json({}, { status: 202 })), 20)),
      confirm: init => {
        init.signal!.addEventListener('abort', () => { confirmationAbortedAt = Date.now(); });
        return waitForAbort(init);
      },
    });
    const run = launch(fetchFn);
    await vi.advanceTimersByTimeAsync(50);
    const result = await run;

    expect(confirmationAbortedAt).toBe(50);
    expect(result.uncertain).toContain('within 30 ms');
    expect(result.outputTail).toContain(result.uncertain);
  });

  it('defaults to a 30000 ms cancellation grace', async () => {
    const fetchFn = mockFetch({ confirm: waitForAbort });
    const run = launch(fetchFn, { cancelGraceMs: undefined });
    await vi.advanceTimersByTimeAsync(30_020);
    const result = await run;

    expect(result.uncertain).toContain('within 30000 ms');
    expect(result.outputTail).toContain(result.uncertain);
  });

  it('reports uncertainty if confirmation fails after cancel was accepted', async () => {
    const fetchFn = mockFetch({ confirm: () => { throw new Error('status unavailable'); } });
    const run = launch(fetchFn);
    await vi.advanceTimersByTimeAsync(50);
    const result = await run;

    expect(result).toMatchObject({ ok: false, timedOut: true, exitCode: null });
    expect(result.uncertain).toContain('status unavailable');
    expect(result.uncertain).toContain('the job may still be running');
    expect(result.outputTail).toContain(result.uncertain);
  });

  it('keeps streamed confirmation output while limiting the tail to 20000 characters', async () => {
    const transcript = 'x'.repeat(25_000);
    const chunks: string[] = [];
    const fetchFn = mockFetch({
      poll: () => Response.json({ status: 'running', transcript }),
      confirm: () => Response.json({ status: 'cancelled', transcript: `${transcript}\nfinished` }),
    });
    const run = launch(fetchFn, {}, chunk => chunks.push(chunk));
    await vi.advanceTimersByTimeAsync(50);
    const result = await run;

    expect(chunks.join('')).toContain(transcript);
    expect(result.outputTail).toHaveLength(20_000);
    expect(result.outputTail).toBe(chunks.join('').slice(-20_000));
    expect(result.outputTail).toContain('finished');
    expect(result.outputTail.trimEnd()).toMatch(/terminal status: cancelled$/);
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
