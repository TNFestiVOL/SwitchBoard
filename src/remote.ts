import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Store, RemoteLease } from './store.js';
import type { EventBus } from './events.js';
import type { Dispatcher } from './dispatcher.js';
import { AGENT_IDS, type Agent, type Task, type Comment } from './types.js';

export interface RemoteOptions {
  tokens: Record<string, string>;
  leaseMs?: number;
  bounceCap: number;
  now?: () => number;
}
export interface WorkOrder {
  runId: number; token: string; leaseMs: number; task: Task;
  project: string; comments: Comment[];
}
const claimSchema = z.object({
  agents: z.array(z.enum(AGENT_IDS)).min(1).max(6),
  projects: z.array(z.string().min(1).max(200)).min(1).max(100),
});
const resultSchema = z.object({
  ok: z.boolean(), timedOut: z.boolean(), exitCode: z.number().int().nullable(),
  outputTail: z.string().max(20_000), inputTokens: z.number().nonnegative().finite(),
  outputTokens: z.number().nonnegative().finite(), costEstimate: z.number().nonnegative().finite(),
  headSha: z.string().regex(/^[0-9a-fA-F]{7,64}$/).optional(),
  dirtyFiles: z.number().int().nonnegative().optional(),
});
const exitedSchema = z.object({
  exitedAt: z.string().datetime({ offset: true }).optional(),
  exitCode: z.number().int().nullable().optional(),
  note: z.string().max(2000).optional(),
});
const equal = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Dedicated LAN surface. No human API, project creation, or unrestricted MCP routes. */
export class RemoteCoordinator {
  readonly app = express();
  private leaseMs: number;
  private now: () => number;
  constructor(private store: Store, private bus: EventBus, private dispatcher: Dispatcher, private opts: RemoteOptions) {
    this.leaseMs = opts.leaseMs ?? 60_000;
    if (this.leaseMs < 1000) throw new Error('leaseMs must be at least 1000');
    for (const [id, token] of Object.entries(opts.tokens)) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || token.length < 32) throw new Error('Worker ids must be valid and tokens at least 32 characters');
    }
    if (new Set(Object.values(opts.tokens)).size !== Object.keys(opts.tokens).length) throw new Error('Each worker needs a distinct token');
    this.now = opts.now ?? Date.now;
    this.app.use(express.json({ limit: '128kb' }));
    this.app.post('/workers/:worker/claim', (req, res) => {
      if (!this.authenticate(req.params.worker, req.headers.authorization)) { res.sendStatus(401); return; }
      const parsed = claimSchema.safeParse(req.body);
      this.store.touchWorker(req.params.worker, 'claim', this.now(), parsed.success ? parsed.data : undefined);
      if (!parsed.success) { res.status(400).json({ error: 'Invalid capabilities' }); return; }
      this.expire();
      let changed = false;
      const order = this.store.transaction(() => {
        if (this.store.getSetting('paused', '0') === '1') return null;
        if (this.store.activeLeases().some(l => l.worker_id === req.params.worker)) return null;
        const running = new Set(this.store.runningRuns().map(r => r.task_id));
        for (const task of this.store.listTasks({ status: 'ready' })) {
          if (task.worker_id !== req.params.worker || !parsed.data.agents.includes(task.assignee as Agent) || running.has(task.id)) continue;
          const project = this.store.getProject(task.project_id)!;
          if (!parsed.data.projects.includes(project.name)) continue;
          if (this.dispatcher.budgetFor(task.assignee as Agent).level !== 'ok' || this.dispatcher.planFor(task.assignee as Agent).blocked) continue;
          if (this.store.unmetDependencies(task.id).length || this.store.listDependencies(task.id).some(id => {
            const dep = this.store.getTask(id)!;
            // Crossing machines requires explicit human confirmation that artifacts were transferred.
            return running.has(id) || ((dep.worker_id ?? null) !== task.worker_id && dep.status !== 'done');
          })) continue;
          if (task.bounce_count >= this.opts.bounceCap) {
            this.store.updateTask(task.id, { status: 'needs_human' });
            this.store.addComment(task.id, 'human', 'Remote dispatch bounce cap reached.');
            changed = true;
            continue;
          }
          const token = randomBytes(32).toString('hex');
          const run = this.store.createRun(task.id, task.assignee as Agent, `Remote worker ${task.worker_id}: ${task.title}`);
          this.store.updateTask(task.id, { status: 'in_progress', bounce_count: task.bounce_count + 1 });
          this.store.createLease({ run_id: run.id, worker_id: task.worker_id!, token, expires_at: this.now() + this.leaseMs });
          changed = true;
          return { runId: run.id, token, leaseMs: this.leaseMs, task, project: project.name, comments: this.store.listComments(task.id) } satisfies WorkOrder;
        }
        return null;
      });
      if (changed) this.bus.change({ kind: 'remote_dispatch_changed' });
      res.json(order);
    });
    this.app.post('/workers/:worker/runs/:run/heartbeat', (req, res) => {
      const lease = this.workerLease(req, res);
      if (!lease) return;
      const parsed = z.object({ output: z.string().max(20_000).optional() }).safeParse(req.body);
      if (!parsed.success) { res.sendStatus(400); return; }
      this.store.updateLease(lease.run_id, this.now() + this.leaseMs, 'active');
      if (parsed.data.output !== undefined) this.store.setRunOutput(lease.run_id, parsed.data.output);
      res.json({ leaseMs: this.leaseMs });
    });
    this.app.post('/workers/:worker/runs/:run/complete', (req, res) => {
      const lease = this.workerLease(req, res, true);
      if (!lease) return;
      const parsed = resultSchema.safeParse(req.body);
      if (!parsed.success) { res.sendStatus(400); return; }
      if (lease.state === 'completed') { res.json({ accepted: true }); return; }
      const result = parsed.data;
      this.store.transaction(() => {
        const run = this.store.getRun(lease.run_id)!;
        const succeeded = result.ok && !result.timedOut && result.exitCode === 0;
        if (succeeded) this.store.markWorkerSuccess(lease.worker_id, this.now());
        this.store.finishRun(run.id, { status: result.timedOut ? 'timeout' : succeeded ? 'succeeded' : 'failed', output_tail: result.outputTail,
          input_tokens: result.inputTokens, output_tokens: result.outputTokens, cost_estimate: result.costEstimate });
        const task = this.store.getTask(run.task_id)!;
        // Same rule as the local dispatcher: a failed run always needs a human; a successful run
        // only moves the task when nobody moved it while the worker was running.
        if (!succeeded) this.store.updateTask(task.id, { status: 'needs_human' });
        else if (task.status === 'in_progress') this.store.updateTask(task.id, { status: lease.disposition });
        const gitInfo = result.headSha !== undefined && result.dirtyFiles !== undefined
          ? ` HEAD ${result.headSha.slice(0, 7)} with ${result.dirtyFiles} uncommitted file(s) on that PC.` : '';
        this.store.addComment(task.id, run.agent, `Worker ${lease.worker_id} ${succeeded ? 'finished' : 'failed'}. Files remain on that PC.\n${result.outputTail.slice(-2000)}${gitInfo}`);
        this.store.updateLease(run.id, this.now(), 'completed');
      });
      this.bus.change({ kind: 'remote_finished' });
      res.json({ accepted: true });
    });
    this.app.all('/runs/:run/mcp', (req, res) => {
      const lease = this.store.getLease(Number(req.params.run));
      if (!lease || !equal(this.bearer(req.headers.authorization), lease.token)) { res.sendStatus(401); return; }
      if (!this.valid(lease)) { res.sendStatus(409); return; }
      void this.mcp(lease, req, res).catch(() => { if (!res.headersSent) res.sendStatus(500); });
    });
    this.app.post('/workers/:worker/runs/:run/exited', (req, res) => {
      if (!this.authenticate(req.params.worker, req.headers.authorization)) { res.sendStatus(401); return; }
      // Exit evidence authenticates the original lease without renewing or expiring it.
      const lease = this.store.getLease(Number(req.params.run));
      const run = lease && this.store.getRun(lease.run_id);
      if (!lease || !run || lease.worker_id !== req.params.worker || !equal(String(req.headers['x-run-token'] ?? ''), lease.token)) { res.sendStatus(403); return; }
      const parsed = exitedSchema.safeParse(req.body);
      if (!parsed.success) { res.sendStatus(400); return; }
      const changed = this.store.transaction(() => {
        this.store.touchWorker(lease.worker_id, 'exited', this.now());
        if (this.store.getRun(run.id)!.reconciled_at !== null) return false;
        const at = parsed.data.exitedAt ?? new Date(this.now()).toISOString();
        this.store.reconcileRun(run.id, `worker:${lease.worker_id}`, at);
        this.store.addComment(run.task_id, run.agent,
          `Worker ${lease.worker_id} reports the process for run ${run.id} exited (${parsed.data.exitCode ?? 'unknown'}) at ${at}. This is evidence the process stopped, not that the work is correct; files on that PC are unchanged by this report.`);
        return true;
      });
      if (changed) this.bus.change({ kind: 'remote_reconciled' });
      res.json({ accepted: true });
    });
  }

  private bearer(header?: string): string { return header?.startsWith('Bearer ') ? header.slice(7) : ''; }
  private authenticate(id: string, header?: string): boolean {
    if (!Object.hasOwn(this.opts.tokens, id)) return false;
    return equal(this.bearer(header), this.opts.tokens[id]);
  }
  private valid(lease: RemoteLease): boolean {
    return lease.state === 'active' && lease.expires_at > this.now() && this.store.getRun(lease.run_id)?.status === 'running';
  }
  private workerLease(req: express.Request, res: express.Response, completed = false): RemoteLease | undefined {
    if (!this.authenticate(req.params.worker, req.headers.authorization)) { res.sendStatus(401); return; }
    this.expire();
    const lease = this.store.getLease(Number(req.params.run));
    if (!lease || lease.worker_id !== req.params.worker || !equal(String(req.headers['x-run-token'] ?? ''), lease.token)) { res.sendStatus(403); return; }
    this.store.touchWorker(lease.worker_id, completed ? 'complete' : 'heartbeat', this.now());
    if (!(completed && lease.state === 'completed') && !this.valid(lease)) { res.sendStatus(409); return; }
    return lease;
  }
  expire(): void {
    let changed = false;
    this.store.transaction(() => {
      for (const lease of this.store.activeLeases()) {
        if (lease.expires_at > this.now()) continue;
        const run = this.store.getRun(lease.run_id)!;
        this.store.finishRun(run.id, { status: 'failed' });
        this.store.setRunUncertain(run.id, `lease expired; worker ${lease.worker_id} may still be running it`);
        this.store.updateTask(run.task_id, { status: 'needs_human' });
        this.store.addComment(run.task_id, 'human', `Lost contact with worker ${lease.worker_id}. Work may still be running there. Stop/check that PC and recover its files before retrying; this task will not be automatically retried.`);
        this.store.updateLease(run.id, this.now(), 'lost');
        changed = true;
      }
    });
    if (changed) this.bus.change({ kind: 'remote_lease_lost' });
  }
  private async mcp(lease: RemoteLease, req: express.Request, res: express.Response): Promise<void> {
    const server = new McpServer({ name: 'switchboard', version: '0.1.0' });
    const run = this.store.getRun(lease.run_id)!;
    const call = (id: number, action: () => unknown, mutates = true) => {
      if (id !== run.task_id || !this.valid(this.store.getLease(run.id)!)) return { isError: true, content: [{ type: 'text' as const, text: 'Task is outside this active run' }] };
      const value = action();
      if (mutates) this.bus.change({ kind: 'remote_task_updated', taskId: id });
      return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
    };
    server.registerTool('get_task', { inputSchema: { id: z.number().int() } }, ({ id }) => call(id, () => ({ task: this.store.getTask(id), comments: this.store.listComments(id) }), false));
    server.registerTool('add_comment', { inputSchema: { id: z.number().int(), body: z.string().max(20_000) } }, ({ id, body }) => call(id, () => this.store.addComment(id, run.agent, body)));
    server.registerTool('finish_task', { inputSchema: { id: z.number().int(), summary: z.string().max(20_000) } }, ({ id, summary }) => call(id, () => {
      this.store.addComment(id, run.agent, summary);
      return { status: 'in_progress', message: 'Summary saved. The worker will finalize after the process exits.' };
    }));
    server.registerTool('update_status', { inputSchema: { id: z.number().int(), status: z.literal('needs_human') } }, ({ id, status }) => call(id, () => {
      this.store.updateLease(run.id, this.store.getLease(run.id)!.expires_at, 'active', status);
      return { status, message: 'Worker will park this task after the process exits.' };
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }
}
