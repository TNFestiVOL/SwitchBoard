import express from 'express';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import { isIP } from 'node:net';
import { join } from 'node:path';
import type { Store } from './store.js';
import type { EventBus } from './events.js';
import type { Dispatcher } from './dispatcher.js';
import { handleMcpRequest } from './mcp.js';
import { toolHandlers, ToolError, ConflictError } from './tools.js';
import { esc, layout, renderBoard, renderTask, type BoardData, type MachineChoice } from './ui.js';
import { plannerBrief } from './prompt.js';
import { DEFAULT_MODEL_CHOICES } from './config.js';
import { AGENTS, type Agent, type Author, type TaskStatus } from './types.js';

export interface AppDeps {
  operatorPassword?: string;
  machines?: MachineChoice[];
  /** Configured remote worker ids; create_task rejects any other worker_id. */
  workers?: ReadonlySet<string>;
  store: Store;
  bus: EventBus;
  dispatcher: Dispatcher;
  shutdown?: () => Promise<void>;
  readiness?: () => { ok: true } | { ok: false; reason: string };
  info?: { version: string; bootId: string };
  /** Per-agent model/effort from config, shown in the UI header. Mutated in place by /api/tuning. */
  agentInfo?: Partial<Record<Agent, { model?: string; effort?: string }>>;
  /** Called after tuning changes so the host can write switchboard.config.json. */
  persistTuning?: () => void;
  /** Model dropdown options; defaults to DEFAULT_MODEL_CHOICES. */
  modelChoices?: Partial<Record<Agent, string[]>>;
}

const MCP_ACTORS = new Set<Author>([...AGENTS, 'human']);

export function attachListenerFailure(server: Server, label: string, exit: (code: number) => void = process.exit): void {
  server.on('error', (error: NodeJS.ErrnoException) => {
    console.error(`[listener] ${label} failed: ${error.code ?? error.message}`);
    exit(1);
  });
}

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (addr === '::1') return true;
  const ipv4 = addr?.replace(/^::ffff:/i, '');
  return ipv4 !== undefined && isIP(ipv4) === 4 && ipv4.startsWith('127.');
}

export const mcpLoopbackGuard: express.RequestHandler = (req, res, next) => {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    res.status(403).json({ error: 'MCP identities are accepted from this machine only. Remote workers use the worker listener.' });
    return;
  }
  next();
};

const SESSION_DAY = 24 * 60 * 60 * 1000;
const SESSION_LIFETIME = 30 * SESSION_DAY;

function operatorAuth(app: express.Express, store: Store, password: string): void {
  const passwordHash = createHash('sha256').update(password).digest();
  const failures = new Map<string, { count: number; expires: number }>();
  const rotateSecret = (): string => {
    const secret = randomBytes(32).toString('hex');
    store.setSetting('session_secret', secret);
    return secret;
  };
  const signature = (timestamp: string, secret: string): Buffer =>
    createHmac('sha256', Buffer.from(secret, 'hex')).update(timestamp).digest();
  const cookieOptions = (req: express.Request): express.CookieOptions => ({
    httpOnly: true, sameSite: 'lax', path: '/', secure: req.secure,
  });
  const setSession = (req: express.Request, res: express.Response): void => {
    const secret = store.getSetting('session_secret', '') || rotateSecret();
    const timestamp = String(Date.now());
    res.cookie('sb_session', `${timestamp}.${signature(timestamp, secret).toString('hex')}`, {
      ...cookieOptions(req), maxAge: SESSION_LIFETIME,
    });
  };
  const sessionAge = (req: express.Request): number | undefined => {
    const cookie = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('sb_session='))?.slice('sb_session='.length);
    const match = cookie?.match(/^(\d{1,16})\.([a-f0-9]{64})$/);
    if (!match) return;
    const timestamp = Number(match[1]);
    const age = Date.now() - timestamp;
    if (!Number.isSafeInteger(timestamp) || age < 0 || age >= SESSION_LIFETIME) return;
    const secret = store.getSetting('session_secret', '');
    if (!secret || !timingSafeEqual(signature(match[1], secret), Buffer.from(match[2], 'hex'))) return;
    return age;
  };
  const safeNext = (value: unknown): string =>
    typeof value === 'string' && /^\/(?!\/)/.test(value) && !/[\\\x00-\x1f\x7f]/.test(value) ? value : '/';
  const loginPage = (next: unknown, error = ''): string => layout('Sign in - Switchboard', `
    <header><a class="brand" href="/" aria-label="Switchboard home"><img src="/logo.png" alt="Switchboard"></a></header>
    <main class="panel"><h2>Sign in</h2>
      ${error ? `<p role="alert">${esc(error)}</p>` : ''}
      <form method="post" action="/login" class="inline">
        <input type="hidden" name="next" value="${esc(safeNext(next))}">
        <label>Password <input type="password" name="password" autocomplete="current-password" required autofocus></label>
        <button type="submit">Sign in</button>
      </form>
    </main>`, 'es.close();');

  app.use((req, res, next) => {
    // MCP keeps its socket-only identity boundary, independently of operator sessions.
    if (/^\/mcp(?:\/|$)/i.test(req.path)) { next(); return; }
    res.set('Cache-Control', 'no-store');
    const age = sessionAge(req);
    if (age !== undefined) {
      res.locals.authenticated = true;
      if (age > SESSION_DAY) setSession(req, res);
      next();
      return;
    }
    const publicRoute = /^\/(?:login|health\/(?:live|ready)|logo\.png)\/?$/i.test(req.path);
    const local = isLoopbackAddress(req.socket.remoteAddress)
      && req.headers['x-forwarded-for'] === undefined && req.headers.forwarded === undefined;
    if (publicRoute || local) { next(); return; }
    if (req.method === 'GET' && /^\/(?:task\/[^/]+\/?)?$/i.test(req.path)) {
      res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    } else {
      res.status(401).json({ error: 'sign in required' });
    }
  });

  app.get('/login', (req, res) => { res.send(loginPage(req.query.next)); });
  app.post('/login', express.urlencoded({ extended: false, limit: '16kb' }), express.json({ limit: '16kb' }), (req, res) => {
    const now = Date.now();
    for (const [address, failure] of failures) {
      if (failure.expires <= now) failures.delete(address);
    }
    const address = req.socket.remoteAddress ?? 'unknown';
    const failure = failures.get(address);
    const next = req.body?.next ?? req.query.next;
    if (failure && failure.count >= 5) {
      res.set('Retry-After', String(Math.ceil((failure.expires - now) / 1000)));
      res.status(429).send(loginPage(next, 'Too many attempts. Try again in a minute.'));
      return;
    }
    const supplied = typeof req.body?.password === 'string' ? req.body.password : '';
    const suppliedHash = createHash('sha256').update(supplied).digest();
    if (!timingSafeEqual(passwordHash, suppliedHash)) {
      const count = (failure?.count ?? 0) + 1;
      failures.set(address, { count, expires: count >= 5 ? now + 60_000 : failure?.expires ?? now + 60_000 });
      res.status(401).send(loginPage(next, 'Incorrect password'));
      return;
    }
    failures.delete(address);
    setSession(req, res);
    res.redirect(safeNext(next));
  });

  app.post('/logout', (req, res) => {
    res.clearCookie('sb_session', cookieOptions(req));
    res.redirect('/login');
  });
  app.post('/logout-all', (req, res) => {
    rotateSecret();
    res.clearCookie('sb_session', cookieOptions(req));
    res.redirect('/login');
  });
}

export function createApp({ store, bus, dispatcher, shutdown, readiness, info, agentInfo, persistTuning, modelChoices, machines, workers, operatorPassword }: AppDeps): express.Express {
  const app = express();
  app.set('trust proxy', 'loopback');
  if (operatorPassword) operatorAuth(app, store, operatorPassword);
  const human = toolHandlers(store, bus, 'human', { workers });
  // Preserve the caller's nested tuning objects (the UI mutates them in place),
  // while ensuring the board has a complete record for all dispatchable agents.
  const tuning = {
    ...Object.fromEntries(AGENTS.map(a => [a, {}])), ...(agentInfo ?? {}),
  } as Record<Agent, { model?: string; effort?: string }>;
  const models = { ...DEFAULT_MODEL_CHOICES, ...(modelChoices ?? {}), nyx: modelChoices?.nyx ?? [] };

  // A planner mid-run is still creating draft tasks; releasing then would launch a partial plan.
  const planningActive = (): boolean =>
    [...store.listTasks({ status: 'in_progress' }), ...store.listTasks({ status: 'ready' })]
      .some(t => t.title.startsWith('Plan:'));

  const depsFor = (tasks: { id: number; status: string }[]): Record<number, { on: number[]; unmet: number[] }> => {
    const map: Record<number, { on: number[]; unmet: number[] }> = {};
    for (const t of tasks) {
      if (t.status === 'done') continue;
      const on = store.listDependencies(t.id);
      if (on.length) map[t.id] = { on, unmet: store.unmetDependencies(t.id) };
    }
    return map;
  };

  const boardData = (authenticated = false): BoardData => ({
    ...(operatorPassword ? { authenticated } : {}),
    machines,
    tasks: store.listTasks(),
    deps: depsFor(store.listTasks()),
    planningActive: planningActive(),
    projects: store.listProjects(),
    budgets: Object.fromEntries(AGENTS.map(a => [a, dispatcher.budgetFor(a)])) as BoardData['budgets'],
    plan: Object.fromEntries(AGENTS.map(a => [a, dispatcher.planFor(a)])) as BoardData['plan'],
    agents: tuning,
    modelChoices: models,
    paused: store.getSetting('paused', '0') === '1',
    draining: store.getSetting('draining', '0') === '1',
    activeRuns: dispatcher.activeRuns(),
  });

  // SSE first — it must not go through the JSON body parser.
  app.get('/events', (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    res.write(`data: ${JSON.stringify({ kind: 'hello', bootId: info?.bootId ?? '' })}\n\n`);
    const onChange = (e: { kind: string; taskId?: number }) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    bus.onChange(onChange);
    const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      bus.offChange(onChange);
    });
  });

  app.get('/health/live', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ ok: true });
  });

  app.get('/health/ready', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      store.ping();
    } catch (error) {
      res.status(503).json({ ok: false, reason: `storage: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    const ready = readiness?.();
    if (ready && !ready.ok) {
      res.status(503).json({ ok: false, reason: ready.reason });
      return;
    }
    res.json({ ok: true });
  });

  app.get('/api/info', (_req, res) => {
    res.json({
      serverId: store.serverId(),
      version: info?.version ?? '0.0.0',
      bootId: info?.bootId ?? '',
      apiVersion: 1,
    });
  });

  app.use(express.json({ limit: '2mb' }));

  // Keep the supplied wordmark as a normal browser asset. The UI crops its
  // intentionally wide canvas into a compact header brand window.
  app.get('/logo.png', (_req, res) => {
    res.sendFile(join(process.cwd(), 'Logo.png'));
  });

  // --- MCP endpoint (identity from path) ---
  app.use('/mcp', mcpLoopbackGuard);
  app.all('/mcp/:agent', (req, res) => {
    const agent = req.params.agent as Author;
    if (!MCP_ACTORS.has(agent)) {
      res.status(404).json({ error: `Unknown MCP identity "${req.params.agent}". Use /mcp/claude, /mcp/codex, /mcp/nyx, or /mcp/human.` });
      return;
    }
    void handleMcpRequest(store, bus, agent, req, res, { workers }).catch(err => {
      if (!res.headersSent) res.status(500).json({ error: String(err) });
    });
  });

  // --- Human JSON API ---
  const guard = (res: express.Response, fn: () => unknown, status = 200): void => {
    try {
      res.status(status).json(fn());
    } catch (e) {
      if (e instanceof ConflictError) res.status(409).json({ error: e.message });
      else if (e instanceof ToolError) res.status(400).json({ error: e.message });
      else res.status(500).json({ error: String(e) });
    }
  };

  app.post('/api/projects', (req, res) => {
    guard(res, () => {
      const { name, path } = req.body as { name?: string; path?: string };
      if (!name || !path) throw new ToolError('name and path are required');
      if (store.getProjectByName(name)) throw new ToolError(`project "${name}" already exists`);
      try {
        mkdirSync(path, { recursive: true }); // a missing dir crashes agent spawns later — create it up front
      } catch (e) {
        throw new ToolError(`cannot create project directory "${path}": ${e instanceof Error ? e.message : e}`);
      }
      const project = store.addProject(name, path);
      bus.change({ kind: 'project_added' });
      return project;
    }, 201);
  });

  app.post('/api/tasks', (req, res) => {
    const { project, title, description, assignee, model, effort, worker_id, client_id } = req.body as Record<string, string>;
    guard(res, () => human.create_task({ project, title, description, assignee: assignee as Author, model, effort, worker_id, client_id }), 201);
  });

  // Planning mode: one big-brained run that decomposes a goal into board tasks
  // and distributes them between the agents. Workers then just follow the board.
  app.post('/api/plan', (req, res) => {
    const { project, goal, planner, model, effort, draft } = req.body as Record<string, string | boolean>;
    guard(res, () => {
      if (planner !== 'claude' && planner !== 'codex') throw new ToolError('planner must be "claude" or "codex"');
      if (typeof goal !== 'string' || !goal.trim()) throw new ToolError('goal is required');
      const isDraft = draft === true || draft === 'on' || draft === 'true';
      const trimmed = goal.trim();
      const title = `Plan: ${trimmed.slice(0, 70)}${trimmed.length > 70 ? '…' : ''}`;
      return human.create_task({
        project: String(project),
        title,
        description: `${trimmed}\n\n${plannerBrief(String(project), planner, isDraft)}`,
        assignee: planner,
        model: model as string,
        effort: effort as string,
      });
    }, 201);
  });

  // Release drafts: flip agent-assigned inbox tasks to ready, in creation order,
  // so a reviewed plan starts executing in its intended sequence.
  app.post('/api/tasks/release', (req, res) => {
    if (planningActive()) {
      res.status(409).json({ error: 'A planner is still creating tasks — wait for it to finish so you release the whole plan, not a slice of it.' });
      return;
    }
    const ids: number[] = [];
    for (const task of store.listTasks({ status: 'inbox' })) {
      if (!(AGENTS as string[]).includes(task.assignee)) continue;
      store.updateTask(task.id, { status: 'ready' });
      ids.push(task.id);
    }
    if (ids.length) bus.change({ kind: 'drafts_released' });
    res.json({ released: ids.length, ids });
  });

  app.post('/api/tasks/:id/comment', (req, res) => {
    const { body, client_id } = req.body as { body?: string; client_id?: string };
    guard(res, () => human.add_comment({ id: Number(req.params.id), body: String(body ?? ''), client_id }));
  });

  app.post('/api/tasks/:id/assign', (req, res) => {
    const { assignee, client_id } = req.body as { assignee: Author; client_id?: string };
    guard(res, () => human.assign_task({ id: Number(req.params.id), assignee, client_id }));
  });

  app.post('/api/tasks/:id/status', (req, res) => {
    const { status, client_id, expected_status } = req.body as { status: TaskStatus; client_id?: string; expected_status?: TaskStatus };
    guard(res, () => human.update_status({ id: Number(req.params.id), status, client_id, expected_status }));
  });

  app.post('/api/tuning', (req, res) => {
    const { agent, model, effort } = req.body as { agent?: string; model?: string; effort?: string };
    if (!(AGENTS as string[]).includes(agent ?? '')) {
      res.status(400).json({ error: `agent must be one of ${AGENTS.join(', ')}` });
      return;
    }
    // Mutate in place: the launcher holds a reference to this same object,
    // so the change applies to the very next dispatched run.
    const selectedAgent = agent as Agent;
    const target = tuning[selectedAgent];
    const previous = { ...target };
    delete target.model;
    delete target.effort;
    if (model?.trim()) target.model = model.trim();
    if (effort?.trim()) target.effort = effort.trim();
    try {
      persistTuning?.();
    } catch (e) {
      delete target.model;
      delete target.effort;
      Object.assign(target, previous);
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
      return;
    }
    bus.change({ kind: 'tuning_changed' });
    res.json({ agent: selectedAgent, tuning: target });
  });

  app.post('/api/pause', (_req, res) => {
    store.setSetting('paused', '1');
    bus.change({ kind: 'paused' });
    res.json({ paused: true });
  });

  app.post('/api/resume', (_req, res) => {
    if (store.getSetting('draining', '0') === '1') {
      res.status(409).json({ error: 'host is draining; clear the drain before resuming' });
      return;
    }
    store.setSetting('paused', '0');
    bus.change({ kind: 'resumed' });
    res.json({ paused: false });
  });

  app.post('/api/drain', (_req, res) => {
    store.setSetting('paused', '1');
    store.setSetting('draining', '1');
    bus.change({ kind: 'draining' });
    res.json({ draining: true, paused: true, activeRuns: dispatcher.activeRuns().length });
  });

  app.post('/api/drain/clear', (_req, res) => {
    store.setSetting('draining', '0');
    bus.change({ kind: 'drain_cleared' });
    res.json({ draining: false });
  });

  app.post('/api/shutdown', (req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.status(403).json({ error: 'host shutdown is accepted from this machine only' });
      return;
    }
    const draining = store.getSetting('draining', '0') === '1';
    const activeRuns = dispatcher.activeRuns().length;
    if (!draining || activeRuns > 0) {
      res.status(409).json({ error: 'host must be draining with no active runs before shutdown', draining, activeRuns });
      return;
    }
    res.once('finish', () => setImmediate(() => { void shutdown?.(); }));
    res.status(202).json({ stopping: true });
  });

  app.get('/api/state', (_req, res) => {
    res.json(boardData(res.locals.authenticated === true));
  });

  app.get('/api/runs/:id/output', (req, res) => {
    const id = Number(req.params.id);
    const live = dispatcher.liveOutput(id);
    if (live !== undefined) {
      res.json({ output: live, live: true });
      return;
    }
    const run = store.getRun(id);
    if (!run) {
      res.status(404).json({ error: `no run ${id}` });
      return;
    }
    res.json({ output: run.output_tail, live: false });
  });

  // --- HTML UI ---
  app.get('/', (_req, res) => {
    res.send(renderBoard(boardData(res.locals.authenticated === true)));
  });

  app.get('/task/:id', (req, res) => {
    const task = store.getTask(Number(req.params.id));
    if (!task) {
      res.status(404).send('No such task');
      return;
    }
    const project = store.getProject(task.project_id)!;
    const activeRunId = dispatcher.activeRuns().find(r => r.taskId === task.id)?.runId;
    res.send(renderTask(
      { task, project, comments: store.listComments(task.id), runs: store.listRuns(task.id), activeRunId },
      boardData(res.locals.authenticated === true),
    ));
  });

  return app;
}
