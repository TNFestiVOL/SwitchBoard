import express from 'express';
import { mkdirSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import type { Store } from './store.js';
import type { EventBus } from './events.js';
import type { Dispatcher } from './dispatcher.js';
import { handleMcpRequest } from './mcp.js';
import { toolHandlers, ToolError, ConflictError } from './tools.js';
import { renderBoard, renderTask, type BoardData, type MachineChoice } from './ui.js';
import { plannerBrief } from './prompt.js';
import { DEFAULT_MODEL_CHOICES } from './config.js';
import { AGENTS, type Agent, type Author, type TaskStatus } from './types.js';

export interface AppDeps {
  machines?: MachineChoice[];
  /** Configured remote worker ids; create_task rejects any other worker_id. */
  workers?: ReadonlySet<string>;
  store: Store;
  bus: EventBus;
  dispatcher: Dispatcher;
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

export function createApp({ store, bus, dispatcher, readiness, info, agentInfo, persistTuning, modelChoices, machines, workers }: AppDeps): express.Express {
  const app = express();
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

  const boardData = (): BoardData => ({
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
    store.setSetting('paused', '0');
    bus.change({ kind: 'resumed' });
    res.json({ paused: false });
  });

  app.get('/api/state', (_req, res) => {
    res.json(boardData());
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
    res.send(renderBoard(boardData()));
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
      boardData(),
    ));
  });

  return app;
}
