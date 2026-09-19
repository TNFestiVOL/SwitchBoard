import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Request, type Response } from 'express';
import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/store.js';
import { EventBus } from '../src/events.js';
import { Dispatcher } from '../src/dispatcher.js';
import { RemoteCoordinator } from '../src/remote.js';
import { attachListenerFailure, createApp, isLoopbackAddress, mcpLoopbackGuard } from '../src/server.js';
import type { Launcher, RunResult } from '../src/launcher.js';

class IdleLauncher implements Launcher {
  launch(): Promise<RunResult> {
    return new Promise(() => { /* never resolves — keeps runs visible as active */ });
  }
}

describe('MCP loopback guard', () => {
  it('recognizes only loopback socket addresses', () => {
    const cases: [string | undefined, boolean][] = [
      ['127.0.0.1', true],
      ['127.23.45.67', true],
      ['127.255.255.255', true],
      ['::1', true],
      ['::ffff:127.0.0.1', true],
      ['::ffff:127.23.45.67', true],
      ['192.0.2.10', false],
      ['::ffff:192.0.2.10', false],
      ['10.0.0.1', false],
      [undefined, false],
      ['localhost', false],
      ['127.0.0.999', false],
      ['127.0.0.1.example', false],
    ];
    for (const [address, expected] of cases) {
      expect(isLoopbackAddress(address), String(address)).toBe(expected);
    }
  });

  it('rejects a LAN socket even when forwarding headers claim loopback', () => {
    const req = {
      socket: { remoteAddress: '192.0.2.20' },
      headers: { 'x-forwarded-for': '127.0.0.1', forwarded: 'for="[::1]"' },
    } as unknown as Request;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    mcpLoopbackGuard(req, res as unknown as Response, next);

    expect(res.status).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({
      error: 'MCP identities are accepted from this machine only. Remote workers use the worker listener.',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('allows a loopback socket without sending a response', () => {
    const req = {
      socket: { remoteAddress: '127.0.0.1' },
      headers: { 'x-forwarded-for': '192.0.2.20' },
    } as unknown as Request;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();

    mcpLoopbackGuard(req, res as unknown as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('listener failures', () => {
  it.each([
    ['board port 4680', 'EADDRINUSE'],
    ['worker port 4781', 'EACCES'],
    ['worker port 4781', 'ENOTFOUND'],
  ])('logs %s and %s before exiting with code 1', (label, code) => {
    const server = new EventEmitter() as Server;
    const exit = vi.fn();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      attachListenerFailure(server, label, exit);
      server.emit('error', Object.assign(new Error('listen failed'), { code }));

      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toContain(label);
      expect(log.mock.calls[0][0]).toContain(code);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
      expect(log.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0]);
    } finally {
      log.mockRestore();
    }
  });
});

describe('operator sessions', () => {
  const password = 'correct horse battery staple';
  const day = 24 * 60 * 60 * 1000;
  let store: Store;
  let bus: EventBus;
  let dispatcher: Dispatcher;
  let app: ReturnType<typeof createApp>;

  const forwarded = { 'X-Forwarded-For': '192.0.2.20' };
  const sessionCookie = (res: request.Response): string => {
    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    return cookies[0].split(';')[0];
  };
  const signedCookie = (issuedAt: number, secret = store.getSetting('session_secret', '')): string => {
    const timestamp = String(issuedAt);
    const signature = createHmac('sha256', Buffer.from(secret, 'hex')).update(timestamp).digest('hex');
    return `sb_session=${timestamp}.${signature}`;
  };
  const fromSocket = (address: string, child = app): express.Express => {
    const parent = express();
    parent.set('trust proxy', true);
    parent.use((req, _res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: address });
      next();
    });
    parent.use(child);
    return parent;
  };
  const login = () => request(app).post('/login').set(forwarded).send({ password });

  beforeEach(() => {
    store = new Store(':memory:');
    bus = new EventBus();
    dispatcher = new Dispatcher(store, new IdleLauncher(), bus, { budgets: {}, bounceCap: 6 });
    store.addProject('private-project', 'Z:/private');
    store.createTask({ project_id: 1, title: 'Private task', description: '', assignee: 'human', created_by: 'human', status: 'inbox' });
    app = createApp({ store, bus, dispatcher, operatorPassword: password });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
  });

  it('keeps the board open when the operator password is unset or empty', async () => {
    for (const operatorPassword of [undefined, '']) {
      const openApp = fromSocket('192.0.2.20', createApp({ store, bus, dispatcher, operatorPassword }));
      for (const path of ['/', '/task/1', '/api/state', '/api/info']) {
        const res = await request(openApp).get(path);
        expect(res.status).toBe(200);
        expect(res.headers['set-cookie']).toBeUndefined();
      }
    }
    expect(store.getSetting('session_secret', '')).toBe('');
  });

  it('redirects unauthenticated HTML requests with their original next path', async () => {
    for (const path of ['/', '/task/1', '/task/1?view=full']) {
      const res = await request(app).get(path).set(forwarded);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`/login?next=${encodeURIComponent(path)}`);
    }
  });

  it('requires sign in for API reads, mutations, events, and unknown routes', async () => {
    for (const path of ['/api/state', '/api/info', '/events', '/unknown', '/health/other']) {
      const res = await request(app).get(path).set(forwarded);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'sign in required' });
    }
    for (const path of ['/api/drain', '/api/drain/clear', '/api/resume', '/api/shutdown', '/logout', '/logout-all']) {
      const res = await request(app).post(path).set(forwarded);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'sign in required' });
    }
    expect(store.getSetting('draining', '0')).toBe('0');
  });

  it('allows health checks and the logo without a session', async () => {
    for (const path of ['/health/live', '/health/ready', '/logo.png']) {
      expect((await request(app).get(path).set(forwarded)).status).toBe(200);
    }
  });

  it('requires an operator session to reconcile over LAN', async () => {
    const run = store.createRun(1, 'claude', '');
    store.setRunUncertain(run.id, 'process state unknown');
    const changes = vi.fn();
    bus.onChange(changes);
    const res = await request(fromSocket('192.0.2.20')).post(`/api/runs/${run.id}/reconcile`).send({});
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'sign in required' });
    expect(store.getRun(run.id)!.reconciled_at).toBeNull();
    expect(store.listComments(1)).toEqual([]);
    expect(changes).not.toHaveBeenCalled();
  });

  it('allows an authenticated operator to reconcile over LAN', async () => {
    const run = store.createRun(1, 'claude', '');
    store.setRunUncertain(run.id, 'process state unknown');
    const cookie = sessionCookie(await login());
    const res = await request(fromSocket('192.0.2.20')).post(`/api/runs/${run.id}/reconcile`)
      .set('Cookie', cookie).send({});
    expect(res.status).toBe(200);
    expect(store.getRun(run.id)!.reconciled_by).toBe('human');
  });

  it('renders an escaped login form using the board layout without private data', async () => {
    const res = await request(app).get('/login').set(forwarded).query({ next: '/task/1?x="<tag>' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('<style>');
    expect(res.text).toMatch(/<form[^>]*method="post"[^>]*action="\/login"/);
    expect(res.text.match(/type="password"/g)).toHaveLength(1);
    expect(res.text).toContain('Sign in</button>');
    expect(res.text).toContain('/task/1?x=&quot;&lt;tag&gt;');
    expect(res.text).not.toContain('Private task');
    expect(res.text).not.toContain('private-project');
    expect(res.text).not.toContain(password);
  });

  it('rejects wrong or missing passwords with an error page and no cookie', async () => {
    for (const body of [{ password: 'wrong' }, {}, { password: ['wrong'] }]) {
      const res = await request(app).post('/login').set(forwarded).send({ ...body, next: '/task/1' });
      expect(res.status).toBe(401);
      expect(res.text).toContain('Incorrect password');
      expect(res.text).toContain('type="password"');
      expect(res.text).toContain('value="/task/1"');
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('accepts JSON login and sets a persistent HttpOnly SameSite cookie', async () => {
    const res = await login();
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(sessionCookie(res)).toMatch(/^sb_session=\d+\.[a-f0-9]{64}$/);
    expect(res.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(res.headers['set-cookie'][0]).toContain('SameSite=Lax');
    expect(res.headers['set-cookie'][0]).toContain('Path=/');
    expect(res.headers['set-cookie'][0]).toContain('Max-Age=2592000');
    expect(res.headers['set-cookie'][0]).not.toContain('Secure');
    expect(store.getSetting('session_secret', '')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('accepts form login and redirects to a safe relative next path', async () => {
    const res = await request(app).post('/login').set(forwarded).type('form').send({ password, next: '/task/1?view=full' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/task/1?view=full');
    expect(sessionCookie(res)).toMatch(/^sb_session=/);
  });

  it('rejects external and browser-normalized external next paths', async () => {
    for (const next of ['//evil.example', 'https://evil.example', '/\\evil.example', '/\t/evil.example', 'relative']) {
      const res = await request(app).post('/login').set(forwarded).send({ password, next });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/');
    }
  });

  it('accepts the session for board, task, and API requests and shows sign out', async () => {
    const cookie = sessionCookie(await login());
    for (const path of ['/', '/task/1', '/api/state']) {
      const res = await request(app).get(path).set(forwarded).set('Cookie', `other=one; ${cookie}; last=two`);
      expect(res.status).toBe(200);
      if (path === '/api/state') expect(res.body.authenticated).toBe(true);
      else expect(res.text).toContain('Sign out</button>');
    }
  });

  it('allows loopback sockets without forwarding headers and without a cookie', async () => {
    for (const address of ['127.0.0.1', '127.23.45.67', '::1', '::ffff:127.0.0.1']) {
      const res = await request(fromSocket(address)).get('/api/state');
      expect(res.status).toBe(200);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    expect((await request(app).get('/')).text).not.toContain('Sign out</button>');
  });

  it('preserves local drain, clear, resume, and shutdown without credentials', async () => {
    for (const path of ['/api/drain', '/api/drain/clear', '/api/resume', '/api/drain']) {
      expect((await request(app).post(path)).status).toBe(200);
    }
    expect((await request(app).post('/api/shutdown')).status).toBe(202);
  });

  it('disallows the local bypass when either forwarding header is present even if empty', async () => {
    for (const [name, value] of [
      ['X-Forwarded-For', '192.0.2.20'], ['X-Forwarded-For', ''],
      ['Forwarded', 'for=192.0.2.20'], ['Forwarded', ''],
    ]) {
      const res = await request(fromSocket('127.0.0.1')).get('/api/state').set(name, value);
      expect(res.status).toBe(401);
    }
  });

  it('never accepts a LAN socket as local based on forwarding headers', async () => {
    const lan = fromSocket('192.0.2.20');
    expect((await request(lan).get('/api/state')).status).toBe(401);
    const res = await request(lan).get('/api/state').set('X-Forwarded-For', '127.0.0.1').set('Forwarded', 'for="[::1]"');
    expect(res.status).toBe(401);
  });

  it('sets Secure only when HTTPS is reported by a trusted loopback proxy', async () => {
    for (const [address, secure] of [['127.0.0.1', true], ['::1', true], ['192.0.2.20', false]] as const) {
      const res = await request(fromSocket(address)).post('/login').set(forwarded)
        .set('X-Forwarded-Proto', 'https').send({ password });
      expect(res.status).toBe(302);
      expect(res.headers['set-cookie'][0].includes('; Secure')).toBe(secure);
    }
  });

  it('clears the current cookie on logout while keeping other sessions valid', async () => {
    const cookie = sessionCookie(await login());
    const res = await request(app).post('/logout').set(forwarded).set('X-Forwarded-Proto', 'https').set('Cookie', cookie);
    expect(res.status).toBe(302);
    expect(res.headers['set-cookie'][0]).toContain('sb_session=;');
    expect(res.headers['set-cookie'][0]).toContain('Expires=Thu, 01 Jan 1970');
    expect(res.headers['set-cookie'][0]).toContain('Secure');
    expect((await request(app).get('/api/state').set(forwarded)).status).toBe(401);
    expect((await request(app).get('/api/state').set(forwarded).set('Cookie', cookie)).status).toBe(200);
  });

  it('rotates the shared secret on logout-all and invalidates every existing session', async () => {
    const cookie = sessionCookie(await login());
    const secret = store.getSetting('session_secret', '');
    const secondApp = createApp({ store, bus, dispatcher, operatorPassword: password });
    const secondCookie = sessionCookie(await request(secondApp).post('/login').send({ password }));
    const res = await request(app).post('/logout-all').set(forwarded).set('Cookie', cookie);
    expect(res.status).toBe(302);
    expect(res.headers['set-cookie'][0]).toContain('sb_session=;');
    expect(store.getSetting('session_secret', '')).not.toBe(secret);
    for (const oldCookie of [cookie, secondCookie]) {
      expect((await request(secondApp).get('/api/state').set(forwarded).set('Cookie', oldCookie)).status).toBe(401);
    }
    const newCookie = sessionCookie(await login());
    expect((await request(app).get('/api/state').set(forwarded).set('Cookie', newCookie)).status).toBe(200);
  });

  it('keeps persisted sessions valid across app recreation', async () => {
    const cookie = sessionCookie(await login());
    const secret = store.getSetting('session_secret', '');
    const recreated = createApp({ store, bus, dispatcher, operatorPassword: password });
    expect((await request(recreated).get('/api/state').set(forwarded).set('Cookie', cookie)).status).toBe(200);
    expect(store.getSetting('session_secret', '')).toBe(secret);
  });

  it('rejects a cookie signed with a different secret', async () => {
    await login();
    const cookie = signedCookie(Date.now(), 'ab'.repeat(32));
    expect((await request(app).get('/api/state').set(forwarded).set('Cookie', cookie)).status).toBe(401);
  });

  it('rejects malformed, tampered, future, and expired sessions', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const cookie = sessionCookie(await login());
    const malformed = ['sb_session=garbage', 'sb_session=%E0%A4%A', 'sb_session=1.00', `${cookie}extra`];
    for (const invalid of [...malformed, signedCookie(now + 1), signedCookie(now - 30 * day)]) {
      const res = await request(app).get('/api/state').set(forwarded).set('Cookie', invalid);
      expect(res.status).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('refreshes sessions older than one day and extends their lifetime', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    await login();
    const res = await request(app).get('/api/state').set(forwarded).set('X-Forwarded-Proto', 'https')
      .set('Cookie', signedCookie(now - 29 * day));
    expect(res.status).toBe(200);
    const renewed = sessionCookie(res);
    expect(renewed).toBe(signedCookie(now));
    expect(res.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(res.headers['set-cookie'][0]).toContain('SameSite=Lax');
    expect(res.headers['set-cookie'][0]).toContain('Secure');
    clock.mockReturnValue(now + 2 * day);
    expect((await request(app).get('/api/state').set(forwarded).set('Cookie', renewed)).status).toBe(200);
  });

  it('does not refresh sessions at or below one day old', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await login();
    for (const age of [0, day]) {
      const res = await request(app).get('/api/state').set(forwarded).set('Cookie', signedCookie(now - age));
      expect(res.status).toBe(200);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('rate limits the sixth failed login per socket for sixty seconds despite changing forwarded clients', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await request(app).post('/login').set('X-Forwarded-For', `192.0.2.${attempt}`).send({ password: 'wrong' });
      expect(res.status).toBe(401);
    }
    const blocked = await request(app).post('/login').set(forwarded).send({ password: 'wrong' });
    expect(blocked.status).toBe(429);
    expect(blocked.headers['set-cookie']).toBeUndefined();
    expect(blocked.headers['retry-after']).toBe('60');
    expect((await login()).status).toBe(429);
    const otherSocket = await request(fromSocket('192.0.2.99')).post('/login').send({ password });
    expect(otherSocket.status).toBe(302);
    clock.mockReturnValue(now + 59_999);
    expect((await login()).status).toBe(429);
    clock.mockReturnValue(now + 60_000);
    expect((await login()).status).toBe(302);
  });

  it('resets failed login counts after a successful sign in', async () => {
    for (let round = 0; round < 2; round++) {
      for (let attempt = 0; attempt < 4; attempt++) {
        expect((await request(app).post('/login').send({ password: 'wrong' })).status).toBe(401);
      }
      expect((await login()).status).toBe(302);
    }
  });

  it('leaves MCP governed only by its existing socket guard', async () => {
    const local = await request(app).post('/mcp/impostor').set(forwarded).send({});
    expect(local.status).toBe(404);
    expect(local.body.error).toContain('Unknown MCP identity');
    const cookie = sessionCookie(await login());
    const remote = await request(fromSocket('192.0.2.20')).post('/mcp/human').set('Cookie', cookie).send({});
    expect(remote.status).toBe(403);
    expect(remote.body.error).toContain('MCP identities');
  });
});

describe('server', () => {
  let store: Store;
  let app: ReturnType<typeof createApp>;
  let dispatcher: Dispatcher;
  let bus: EventBus;
  let httpServer: Server | undefined;

  beforeEach(() => {
    store = new Store(':memory:');
    bus = new EventBus();
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

  it('reports liveness without touching storage or readiness', async () => {
    const closedStore = new Store(':memory:');
    const readiness = vi.fn(() => ({ ok: false as const, reason: 'unavailable' }));
    const liveApp = createApp({ store: closedStore, bus: new EventBus(), dispatcher, readiness });
    closedStore.close();

    const res = await request(liveApp).get('/health/live');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(readiness).not.toHaveBeenCalled();
  });

  it('reports readiness with default dependencies and disables caching', async () => {
    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('reports the worker readiness reason and rechecks it on each request', async () => {
    const readiness = vi.fn<() => { ok: true } | { ok: false; reason: string }>()
      .mockReturnValueOnce({ ok: false, reason: 'worker listener on 4781 is not bound' })
      .mockReturnValue({ ok: true });
    const readyApp = createApp({ store, bus: new EventBus(), dispatcher, readiness });

    const unavailable = await request(readyApp).get('/health/ready');
    const available = await request(readyApp).get('/health/ready');

    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toEqual({ ok: false, reason: 'worker listener on 4781 is not bound' });
    expect(unavailable.headers['cache-control']).toBe('no-store');
    expect(available.status).toBe(200);
    expect(available.body).toEqual({ ok: true });
    expect(readiness).toHaveBeenCalledTimes(2);
  });

  it('reports closed storage before checking worker readiness', async () => {
    const closedStore = new Store(':memory:');
    const readiness = vi.fn(() => ({ ok: true as const }));
    const readyApp = createApp({ store: closedStore, bus: new EventBus(), dispatcher, readiness });
    closedStore.close();

    const res = await request(readyApp).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, reason: expect.stringMatching(/^storage: .+/) });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(readiness).not.toHaveBeenCalled();
  });

  it('returns only stable server identity and supplied public host information', async () => {
    const infoApp = createApp({
      store, bus: new EventBus(), dispatcher,
      info: { version: '1.2.3', bootId: 'boot-for-test' },
    });

    const first = await request(infoApp).get('/api/info');
    const second = await request(infoApp).get('/api/info');

    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      serverId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      version: '1.2.3', bootId: 'boot-for-test', apiVersion: 1,
    });
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
  });

  it('uses default version and boot identity when host information is omitted', async () => {
    const res = await request(app).get('/api/info');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      serverId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      version: '0.0.0', bootId: '', apiVersion: 1,
    });
  });

  it.each(['/health/live', '/health/ready', '/api/info'])('serves %s to LAN sockets before JSON parsing', async path => {
    const lanApp = express();
    lanApp.use((req, _res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: '192.0.2.20' });
      next();
    });
    lanApp.use(app);

    const res = await request(lanApp).get(path).set('Content-Type', 'application/json').send('{invalid');

    expect(res.status).toBe(200);
  });

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

  it.each(['boot-test', undefined])('sends hello with bootId=%s as the first SSE data frame', async bootId => {
    const bus = new EventBus();
    const eventsApp = createApp({ store, bus, dispatcher, info: bootId ? { version: '1.0.0', bootId } : undefined });
    await new Promise<void>(resolve => { httpServer = eventsApp.listen(0, '127.0.0.1', resolve); });
    const port = (httpServer!.address() as { port: number }).port;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    let received = '';
    try {
      const response = await fetch(`http://127.0.0.1:${port}/events`, { signal: controller.signal });
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      try {
        while (!received.includes('data: ') || !received.slice(received.indexOf('data: ')).includes('\n\n')) {
          const { value, done } = await reader.read();
          if (done) break;
          received += decoder.decode(value, { stream: true });
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally { await reader.cancel().catch(() => {}); }
      expect(received.startsWith('retry: 3000\n\n')).toBe(true);
      const first = received.split('\n\n').find(frame => frame.startsWith('data: '));
      expect(first).toBe(`data: ${JSON.stringify({ kind: 'hello', bootId: bootId ?? '' })}`);
    } finally {
      clearTimeout(timeout);
      controller.abort();
      httpServer!.closeAllConnections();
    }
  });

  const retryCases = [
    { operation: 'create_task', path: '/api/tasks', args: { project: 'staging', title: 'retry', assignee: 'human' }, changed: { title: 'changed' }, status: 201 },
    { operation: 'add_comment', path: '/api/tasks/1/comment', args: { id: 1, body: 'retry' }, changed: { body: 'changed' }, status: 200 },
    { operation: 'assign_task', path: '/api/tasks/1/assign', args: { id: 1, assignee: 'codex' }, changed: { assignee: 'human' }, status: 200 },
    { operation: 'update_status', path: '/api/tasks/1/status', args: { id: 1, status: 'ready' }, changed: { status: 'done' }, status: 200 },
  ];

  it('returns 409 for a stale status comparison and leaves API state unchanged', async () => {
    store.createTask({ project_id: 1, title: 't', description: '', assignee: 'human', created_by: 'human', status: 'needs_human' });
    const before = (await request(app).get('/api/state')).body.tasks;
    const res = await request(app).post('/api/tasks/1/status').send({ status: 'done', expected_status: 'in_progress' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'task is now needs_human, not in_progress; reload and try again' });
    expect((await request(app).get('/api/state')).body.tasks).toEqual(before);
  });

  it('accepts expected_status through MCP and rejects stale transitions', async () => {
    store.createTask({ project_id: 1, title: 't', description: '', assignee: 'human', created_by: 'human', status: 'needs_human' });
    await new Promise<void>(resolve => { httpServer = app.listen(0, '127.0.0.1', resolve); });
    const port = (httpServer!.address() as { port: number }).port;
    const client = new Client({ name: 'test', version: '0.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/human`)));
      const stale = await client.callTool({ name: 'update_status', arguments: { id: 1, status: 'done', expected_status: 'in_progress' } });
      expect(stale.isError).toBe(true);
      expect(stale.content).toEqual([{ type: 'text', text: 'task is now needs_human, not in_progress; reload and try again' }]);
      expect(store.getTask(1)?.status).toBe('needs_human');
      const matched = await client.callTool({ name: 'update_status', arguments: { id: 1, status: 'done', expected_status: 'needs_human' } });
      expect(matched.isError).not.toBe(true);
      expect(store.getTask(1)?.status).toBe('done');
    } finally { await client.close(); }
  });

  describe.each(retryCases)('$operation retries', ({ operation, path, args, changed, status }) => {
    beforeEach(() => {
      if (operation !== 'create_task') store.createTask({
        project_id: 1, title: 'existing', description: '', assignee: 'human', created_by: 'human', status: 'inbox',
      });
    });

    it('returns byte-identical HTTP JSON without repeating the action', async () => {
      const body = { ...args, client_id: 'http_retry' };
      const first = await request(app).post(path).send(body);
      expect(first.status).toBe(status);
      if (operation === 'assign_task' || operation === 'update_status') store.updateTask(1, { status: 'review' });
      const before = store.getTask(1);
      const replay = await request(app).post(path).send(body);
      expect(replay.status).toBe(status);
      expect(replay.text).toBe(first.text);
      expect(store.listTasks()).toHaveLength(1);
      expect(store.listComments(1)).toHaveLength(operation === 'add_comment' ? 1 : 0);
      expect(store.getTask(1)).toEqual(before);
    });

    it('returns HTTP 409 when client_id is reused for a different body', async () => {
      expect((await request(app).post(path).send({ ...args, client_id: 'conflict' })).status).toBe(status);
      const res = await request(app).post(path).send({ ...args, ...changed, client_id: 'conflict' });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'client_id was already used with a different request' });
    });

    it('accepts client_id through MCP and replays the saved result', async () => {
      await new Promise<void>(resolve => { httpServer = app.listen(0, '127.0.0.1', resolve); });
      const port = (httpServer!.address() as { port: number }).port;
      const client = new Client({ name: 'test', version: '0.0.0' });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/human`)));
        const input = { name: operation, arguments: { ...args, client_id: 'mcp_retry' } };
        const first = await client.callTool(input);
        expect(first.isError).not.toBe(true);
        if (operation === 'assign_task' || operation === 'update_status') store.updateTask(1, { status: 'review' });
        const before = store.getTask(1);
        expect(await client.callTool(input)).toEqual(first);
        expect(store.listTasks()).toHaveLength(1);
        expect(store.listComments(1)).toHaveLength(operation === 'add_comment' ? 1 : 0);
        expect(store.getTask(1)).toEqual(before);
      } finally { await client.close(); }
    });
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

  it.each([
    { label: 'existing values', previous: { model: 'old', effort: 'high' } },
    { label: 'defaults', previous: {} },
  ])('restores tuning $label without emitting a change when persistence fails', async ({ previous }) => {
    const target = { ...previous };
    const agentInfo = { codex: target };
    const bus2 = new EventBus();
    const changes = vi.fn();
    bus2.onChange(changes);
    const d2 = new Dispatcher(store, new IdleLauncher(), bus2, { budgets: {}, bounceCap: 6 });
    const persistTuning = vi.fn(() => { throw new Error('tuning could not be saved'); });
    const app2 = createApp({ store, bus: bus2, dispatcher: d2, agentInfo, persistTuning });

    const res = await request(app2).post('/api/tuning').send({ agent: 'codex', model: 'x' });
    const state = await request(app2).get('/api/state');

    expect(res.status).toBe(500);
    expect(state.body.agents.codex).toEqual(previous);
    expect(agentInfo.codex).toBe(target);
    expect(target).toStrictEqual(previous);
    expect(res.body).toEqual({ error: 'tuning could not be saved' });
    expect(persistTuning).toHaveBeenCalledTimes(1);
    expect(changes).not.toHaveBeenCalled();
  });

  it('pauses and resumes dispatch', async () => {
    await request(app).post('/api/pause');
    expect(store.getSetting('paused', '0')).toBe('1');
    await request(app).post('/api/resume');
    expect(store.getSetting('paused', '0')).toBe('0');
  });

  it('drains dispatch by persisting both flags and reporting active runs', async () => {
    store.createTask({ project_id: 1, title: 'Running job', description: '', assignee: 'claude', created_by: 'human', status: 'ready' });
    dispatcher.tick();
    expect(dispatcher.activeRuns()).toHaveLength(1);
    const changes = vi.fn();
    bus.onChange(changes);

    const res = await request(app).post('/api/drain');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ draining: true, paused: true, activeRuns: 1, uncertainRuns: 0 });
    expect(store.getSetting('paused', '')).toBe('1');
    expect(store.getSetting('draining', '')).toBe('1');
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenCalledWith({ kind: 'draining' });
  });

  it('refuses resume while draining without changing settings or emitting events', async () => {
    store.setSetting('paused', '1');
    store.setSetting('draining', '1');
    const changes = vi.fn();
    bus.onChange(changes);

    const res = await request(app).post('/api/resume');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'host is draining; clear the drain before resuming' });
    expect(store.getSetting('paused', '')).toBe('1');
    expect(store.getSetting('draining', '')).toBe('1');
    expect(changes).not.toHaveBeenCalled();
  });

  it('clears only the drain latch and requires explicit resume to dispatch', async () => {
    store.setSetting('paused', '1');
    store.setSetting('draining', '1');
    const task = store.createTask({ project_id: 1, title: 'Waiting job', description: '', assignee: 'claude', created_by: 'human', status: 'ready' });
    const changes = vi.fn();
    bus.onChange(changes);

    const res = await request(app).post('/api/drain/clear');

    expect(res.status).toBe(200);
    expect(store.getSetting('paused', '')).toBe('1');
    expect(store.getSetting('draining', '')).toBe('0');
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenCalledWith({ kind: 'drain_cleared' });
    dispatcher.tick();
    expect(dispatcher.activeRuns()).toEqual([]);
    expect(store.getTask(task.id)!.status).toBe('ready');

    expect((await request(app).post('/api/resume')).status).toBe(200);
    expect(store.getSetting('paused', '')).toBe('0');
    expect(dispatcher.activeRuns()).toHaveLength(1);
  });

  it('reports the drain latch in state before, during, and after a drain', async () => {
    expect((await request(app).get('/api/state')).body.draining).toBe(false);
    await request(app).post('/api/drain');
    expect((await request(app).get('/api/state')).body.draining).toBe(true);
    await request(app).post('/api/drain/clear');
    expect((await request(app).get('/api/state')).body.draining).toBe(false);
  });

  it('does not dispatch ready jobs while draining', async () => {
    const task = store.createTask({ project_id: 1, title: 'Waiting job', description: '', assignee: 'claude', created_by: 'human', status: 'ready' });

    const res = await request(app).post('/api/drain');
    dispatcher.tick();

    expect(dispatcher.activeRuns()).toEqual([]);
    expect(store.getTask(task.id)!.status).toBe('ready');
    expect(res.body).toEqual({ draining: true, paused: true, activeRuns: 0, uncertainRuns: 0 });
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

  it('reports worker contact and success in state only for machines with recorded contact', async () => {
    const machines = [
      { workerId: null, name: 'Infinity', ip: '', configured: true },
      { workerId: 'seen', name: 'Seen PC', ip: '192.0.2.21', configured: true },
      { workerId: 'unseen', name: 'Unseen PC', ip: '192.0.2.22', configured: true },
    ];
    const contactAt = 1_800_000_000_000;
    const token = 'x'.repeat(32);
    const remote = new RemoteCoordinator(store, bus, dispatcher, {
      tokens: { seen: token }, bounceCap: 6, now: () => contactAt,
    });
    const claim = await request(remote.app).post('/workers/seen/claim')
      .set('Authorization', `Bearer ${token}`).send({ agents: ['claude'], projects: ['staging'] });
    expect(claim.status).toBe(200);
    store.touchWorker('Infinity', 'claim', contactAt);
    const fleetApp = createApp({ store, bus, dispatcher, machines });

    const state = await request(fleetApp).get('/api/state');
    expect(state.status).toBe(200);
    expect(state.body.machines).toEqual([
      machines[0], { ...machines[1], lastContactAt: contactAt, lastContactKind: 'claim' }, machines[2],
    ]);
    store.markWorkerSuccess('seen', contactAt + 1000);
    expect((await request(fleetApp).get('/api/state')).body.machines[1].lastSuccessAt).toBe(contactAt + 1000);
    expect(machines[1]).not.toHaveProperty('lastContactAt');
  });

  it('lists uncertain runs with task titles in state and drops reconciled runs', async () => {
    const task = store.createTask({ project_id: 1, title: 'Lost job', description: '', assignee: 'claude', created_by: 'human', status: 'needs_human' });
    const run = store.createRun(task.id, 'claude', '');
    store.finishRun(run.id, { status: 'failed' });
    expect((await request(app).get('/api/state')).body.uncertainRuns).toEqual([]);
    store.setRunUncertain(run.id, 'lease expired');
    expect((await request(app).get('/api/state')).body.uncertainRuns).toEqual([
      { runId: run.id, taskId: task.id, taskTitle: task.title, agent: run.agent, reason: 'lease expired' },
    ]);
    store.reconcileRun(run.id, 'human', new Date().toISOString());
    expect((await request(app).get('/api/state')).body.uncertainRuns).toEqual([]);
  });

  it('rejects shutdown from a LAN socket even with loopback forwarding headers', async () => {
    store.setSetting('paused', '1');
    store.setSetting('draining', '1');
    const shutdown = vi.fn(async () => {});
    const lanApp = express();
    lanApp.set('trust proxy', true);
    lanApp.use((req, _res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: '192.0.2.20' });
      next();
    });
    lanApp.use(createApp({ store, bus, dispatcher, shutdown }));

    const res = await request(lanApp).post('/api/shutdown')
      .set('X-Forwarded-For', '127.0.0.1').set('Forwarded', 'for="[::1]"');

    expect(res.status).toBe(403);
    expect(shutdown).not.toHaveBeenCalled();
  });

  describe('run reconciliation', () => {
    const uncertainRun = () => {
      const task = store.createTask({ project_id: 1, title: 'Uncertain job', description: '', assignee: 'claude', created_by: 'human', status: 'needs_human' });
      const run = store.createRun(task.id, 'claude', '');
      store.finishRun(run.id, { status: 'failed' });
      store.setRunUncertain(run.id, 'process state unknown');
      return store.getRun(run.id)!;
    };

    it('records human reconciliation with one comment and event without changing run or task status', async () => {
      const run = uncertainRun();
      const task = store.getTask(run.task_id);
      const changes = vi.fn();
      bus.onChange(changes);
      const before = Date.now();
      const res = await request(app).post(`/api/runs/${run.id}/reconcile`).send({ note: 'Checked the worker.' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ reconciled: true, runId: run.id });
      const reconciled = store.getRun(run.id)!;
      expect(reconciled).toEqual({ ...run, reconciled_by: 'human', reconciled_at: expect.any(String) });
      expect(Date.parse(reconciled.reconciled_at!)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(reconciled.reconciled_at!)).toBeLessThanOrEqual(Date.now());
      expect(store.getTask(run.task_id)).toEqual(task);
      expect(store.listComments(run.task_id)).toEqual([expect.objectContaining({
        author: 'human',
        body: `Run ${run.id} marked reconciled by the operator. Note: Checked the worker. The process state was confirmed by a person; the work itself is still to be reviewed.`,
      })]);
      expect(changes).toHaveBeenCalledTimes(1);
      expect(changes).toHaveBeenCalledWith({ kind: 'run_reconciled', taskId: run.task_id });
    });

    it('accepts reconciliation without a JSON body or note', async () => {
      const run = uncertainRun();
      const res = await request(app).post(`/api/runs/${run.id}/reconcile`);
      expect(res.status).toBe(200);
      expect(store.listComments(run.task_id)[0].body).toBe(`Run ${run.id} marked reconciled by the operator. The process state was confirmed by a person; the work itself is still to be reviewed.`);
    });

    it('rejects repeat reconciliation without another comment or event', async () => {
      const run = uncertainRun();
      await request(app).post(`/api/runs/${run.id}/reconcile`).send({});
      const before = store.getRun(run.id);
      const changes = vi.fn();
      bus.onChange(changes);
      const res = await request(app).post(`/api/runs/${run.id}/reconcile`).send({ note: 'Again' });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: expect.any(String) });
      expect(store.getRun(run.id)).toEqual(before);
      expect(store.listComments(run.task_id)).toHaveLength(1);
      expect(changes).not.toHaveBeenCalled();
    });

    it('rejects reconciliation of a run that is not uncertain', async () => {
      const run = uncertainRun();
      const certain = store.createRun(run.task_id, 'claude', '');
      const res = await request(app).post(`/api/runs/${certain.id}/reconcile`).send({});
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: expect.any(String) });
      expect(store.getRun(certain.id)).toEqual(certain);
      expect(store.listComments(run.task_id)).toEqual([]);
    });

    it('returns 404 when reconciling an unknown run', async () => {
      const res = await request(app).post('/api/runs/999/reconcile').send({});
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: expect.any(String) });
    });

    it.each([
      ['overlong', 'x'.repeat(2001)], ['numeric', 42], ['null', null],
    ])('rejects an invalid reconciliation note (%s) without side effects', async (_label, note) => {
      const run = uncertainRun();
      const changes = vi.fn();
      bus.onChange(changes);
      const res = await request(app).post(`/api/runs/${run.id}/reconcile`).send({ note });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: expect.any(String) });
      expect(store.getRun(run.id)).toEqual(run);
      expect(store.listComments(run.task_id)).toEqual([]);
      expect(changes).not.toHaveBeenCalled();
    });

    it('accepts a reconciliation note at the 2000 character limit', async () => {
      const run = uncertainRun();
      const note = 'x'.repeat(2000);
      expect((await request(app).post(`/api/runs/${run.id}/reconcile`).send({ note })).status).toBe(200);
      expect(store.listComments(run.task_id)[0].body).toContain(` Note: ${note} The process state`);
    });
  });

  it('refuses shutdown when paused without a drain latch', async () => {
    store.setSetting('paused', '1');
    const shutdown = vi.fn(async () => {});
    const shutdownApp = createApp({ store, bus, dispatcher, shutdown });

    const res = await request(shutdownApp).post('/api/shutdown');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: expect.any(String), draining: false, activeRuns: 0 });
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('refuses shutdown while draining with an active run and reports its count', async () => {
    store.createTask({ project_id: 1, title: 'Running job', description: '', assignee: 'claude', created_by: 'human', status: 'ready' });
    dispatcher.tick();
    await request(app).post('/api/drain');
    const shutdown = vi.fn(async () => {});
    const shutdownApp = createApp({ store, bus, dispatcher, shutdown });

    const res = await request(shutdownApp).post('/api/shutdown');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: expect.any(String), draining: true, activeRuns: 1 });
    expect(dispatcher.activeRuns()).toHaveLength(1);
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('reports the unreconciled run count when draining', async () => {
    const task = store.createTask({ project_id: 1, title: 'Lost job', description: '', assignee: 'claude', created_by: 'human', status: 'needs_human' });
    const run = store.createRun(task.id, 'claude', '');
    store.finishRun(run.id, { status: 'failed' });
    store.setRunUncertain(run.id, 'lease expired');
    const res = await request(app).post('/api/drain');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ draining: true, paused: true, activeRuns: 0, uncertainRuns: 1 });
    await request(app).post(`/api/runs/${run.id}/reconcile`).send({});
    expect((await request(app).post('/api/drain')).body.uncertainRuns).toBe(0);
  });

  it.each([1, 2])('refuses idle drained shutdown until all %i uncertain runs are reconciled', async count => {
    const task = store.createTask({ project_id: 1, title: 'Lost job', description: '', assignee: 'claude', created_by: 'human', status: 'needs_human' });
    const runs = Array.from({ length: count }, () => {
      const run = store.createRun(task.id, 'claude', '');
      store.finishRun(run.id, { status: 'failed' });
      store.setRunUncertain(run.id, 'lease expired');
      return { runId: run.id, taskId: task.id, taskTitle: task.title, agent: run.agent, reason: 'lease expired' };
    });
    await request(app).post('/api/drain');
    const shutdown = vi.fn(async () => {});
    const shutdownApp = createApp({ store, bus, dispatcher, shutdown });
    for (let i = 0; i < runs.length; i++) {
      const res = await request(shutdownApp).post('/api/shutdown');
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: `${count - i} uncertain run(s) must be reconciled before shutdown`, uncertainRuns: runs.slice(i),
      });
      expect(dispatcher.activeRuns()).toEqual([]);
      expect(shutdown).not.toHaveBeenCalled();
      expect((await request(app).post(`/api/runs/${runs[i].runId}/reconcile`).send({})).status).toBe(200);
    }
    const accepted = await request(shutdownApp).post('/api/shutdown');
    expect(accepted.status).toBe(202);
    expect(accepted.body).toEqual({ stopping: true });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('accepts idle drained shutdown and invokes it once after the response finishes', async () => {
    await request(app).post('/api/drain');
    const events: string[] = [];
    const shutdown = vi.fn(async () => { events.push('shutdown'); });
    const shutdownApp = express();
    shutdownApp.use((_req, res, next) => {
      res.once('finish', () => { events.push('response finished'); });
      next();
    });
    shutdownApp.use(createApp({ store, bus, dispatcher, shutdown }));

    const res = await request(shutdownApp).post('/api/shutdown');
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ stopping: true });
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['response finished', 'shutdown']);
  });

  it('accepts idle drained shutdown when no shutdown callback is provided', async () => {
    await request(app).post('/api/drain');

    const res = await request(app).post('/api/shutdown');
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ stopping: true });
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
