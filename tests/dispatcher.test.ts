import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../src/store.js';
import { EventBus } from '../src/events.js';
import { Dispatcher } from '../src/dispatcher.js';
import type { Launcher, RunResult } from '../src/launcher.js';
import type { Agent } from '../src/types.js';

interface LaunchCall {
  agent: Agent;
  prompt: string;
  cwd: string;
  tuning?: { model?: string; effort?: string };
  resolve: (r: RunResult) => void;
}

class FakeLauncher implements Launcher {
  calls: LaunchCall[] = [];
  launch(agent: Agent, prompt: string, cwd: string, onOutput?: (c: string) => void, tuning?: { model?: string; effort?: string }): Promise<RunResult> {
    onOutput?.('fake output\n');
    return new Promise(resolve => {
      this.calls.push({ agent, prompt, cwd, tuning, resolve });
    });
  }
}

const okResult: RunResult = {
  ok: true, timedOut: false, exitCode: 0, outputTail: 'fake tail',
  inputTokens: 100, outputTokens: 40, costEstimate: 0.01,
};
const failResult: RunResult = { ...okResult, ok: false, exitCode: 1, outputTail: 'boom stack trace' };

const flush = () => new Promise(r => setTimeout(r, 10));

describe('Dispatcher', () => {
  let store: Store;
  let bus: EventBus;
  let launcher: FakeLauncher;

  const make = (opts: Partial<ConstructorParameters<typeof Dispatcher>[3]> = {}) =>
    new Dispatcher(store, launcher, bus, {
      budgets: { claude: { soft: 0, hard: 0 }, codex: { soft: 0, hard: 0 } },
      bounceCap: 6,
      ...opts,
    });

  // Real directory: the dispatcher pre-flights that the project path exists.
  const seedTask = (project = 'p1', agent: Agent = 'claude', title = 'work') => {
    const p = store.getProjectByName(project) ?? store.addProject(project, process.cwd());
    return store.createTask({
      project_id: p.id, title, description: 'd', assignee: agent, created_by: 'human', status: 'ready',
    });
  };

  beforeEach(() => {
    store = new Store(':memory:');
    bus = new EventBus();
    launcher = new FakeLauncher();
  });

  it('dispatches a ready agent task', async () => {
    const d = make();
    const t = seedTask();
    d.tick();
    await flush();
    expect(launcher.calls).toHaveLength(1);
    expect(launcher.calls[0].agent).toBe('claude');
    expect(launcher.calls[0].cwd).toBe(process.cwd());
    expect(launcher.calls[0].prompt).toContain('work');
    const after = store.getTask(t.id)!;
    expect(after.status).toBe('in_progress');
    expect(after.bounce_count).toBe(1);
    expect(store.runningRuns()).toHaveLength(1);
    expect(d.activeRuns()).toHaveLength(1);
  });

  it('does nothing while paused', async () => {
    store.setSetting('paused', '1');
    make().tick();
    seedTask();
    await flush();
    expect(launcher.calls).toHaveLength(0);
  });

  it('serializes per project but parallelizes across projects', async () => {
    const d = make();
    seedTask('p1', 'claude', 'first');
    seedTask('p1', 'codex', 'second');   // same project — must wait
    seedTask('p2', 'codex', 'third');    // different project + different agent — may run
    d.tick();
    await flush();
    expect(launcher.calls.map(c => c.prompt.includes('first') ? 'first' : 'third').sort()).toEqual(['first', 'third']);
    expect(launcher.calls).toHaveLength(2);
    // finish the p1 run → the queued p1 task dispatches
    launcher.calls.find(c => c.prompt.includes('third'))!.resolve(okResult); // free codex
    launcher.calls.find(c => c.prompt.includes('first'))!.resolve(okResult); // free p1
    await flush();
    expect(launcher.calls).toHaveLength(3);
  });

  it('never runs the same agent twice concurrently by default', async () => {
    const d = make();
    seedTask('p1', 'claude');
    seedTask('p2', 'claude');
    d.tick();
    await flush();
    expect(launcher.calls).toHaveLength(1);
  });

  it('runs the same agent in parallel across projects when agentConcurrency allows', async () => {
    const d = make({ agentConcurrency: { claude: 1, codex: 2 } });
    seedTask('p1', 'codex');
    seedTask('p2', 'codex');
    seedTask('p3', 'codex'); // third stays queued — only 2 slots
    d.tick();
    await flush();
    expect(launcher.calls).toHaveLength(2);
    launcher.calls[0].resolve(okResult);
    await flush();
    expect(launcher.calls).toHaveLength(3); // freed slot picks up the third
  });

  it('respects agentConcurrency for nyx runs', async () => {
    const d = make({ agentConcurrency: { nyx: 2 } });
    seedTask('p1', 'nyx', 'first nyx task');
    seedTask('p2', 'nyx', 'second nyx task');
    seedTask('p3', 'nyx', 'third nyx task');
    d.tick();
    await flush();
    expect(launcher.calls).toHaveLength(2);
    expect(launcher.calls.every(call => call.agent === 'nyx')).toBe(true);
  });

  it('lets two codex runs share one git project via worktrees with concurrency 2', async () => {
    const fakeWt = {
      isGitRepo: () => true,
      create: (_p: string, taskId: number, runId: number) => ({ dir: `wt-${runId}`, branch: `sb/t${taskId}-r${runId}` }),
      finalize: () => ({ merged: true, changed: true, conflictFiles: [] }),
      abandon: () => ({ changed: false }),
      cleanupOrphans: () => {},
    };
    const d = make({ parallel: true, worktrees: fakeWt as never, agentConcurrency: { claude: 1, codex: 2 } });
    seedTask('p1', 'codex', 'chain one');
    seedTask('p1', 'codex', 'chain two');
    d.tick();
    await flush();
    expect(launcher.calls).toHaveLength(2);
    expect(new Set(launcher.calls.map(c => c.cwd)).size).toBe(2); // separate worktrees
  });

  it('enforces the bounce cap', async () => {
    const d = make({ bounceCap: 2 });
    const t = seedTask();
    store.updateTask(t.id, { bounce_count: 2 });
    d.tick();
    await flush();
    expect(launcher.calls).toHaveLength(0);
    const after = store.getTask(t.id)!;
    expect(after.status).toBe('needs_human');
    expect(store.listComments(t.id).some(c => c.body.toLowerCase().includes('bounce'))).toBe(true);
  });

  it('blocks dispatch at the soft budget line and reports level', async () => {
    const p = store.addProject('p1', process.cwd());
    const spent = store.createTask({ project_id: p.id, title: 'old', description: '', assignee: 'claude', created_by: 'human', status: 'done' });
    const r = store.createRun(spent.id, 'claude', 'x');
    store.finishRun(r.id, { status: 'succeeded', input_tokens: 100, output_tokens: 60 });
    const d = make({ budgets: { claude: { soft: 150, hard: 0 }, codex: { soft: 0, hard: 0 } } });
    seedTask('p1', 'claude');
    d.tick();
    await flush();
    expect(launcher.calls).toHaveLength(0);
    expect(d.budgetFor('claude').level).toBe('soft');
    expect(d.budgetFor('claude').used).toBe(160);
    expect(d.budgetFor('codex').level).toBe('ok');
  });

  it('blocks dispatch when true plan usage exceeds planMaxPercent', async () => {
    const tracker = {
      maxUsedPercent: (agent: Agent) => (agent === 'claude' ? 95 : 10),
      get: () => null,
    };
    const d = make({
      planTracker: tracker as never,
      planMaxPercent: { claude: 90, codex: 90 },
    });
    seedTask('p1', 'claude');
    seedTask('p2', 'codex');
    d.tick();
    await flush();
    expect(launcher.calls).toHaveLength(1); // codex ran, claude gated
    expect(launcher.calls[0].agent).toBe('codex');
    expect(d.planFor('claude').blocked).toBe(true);
    expect(d.planFor('codex').blocked).toBe(false);
  });

  it('ignores plan gating when planMaxPercent is 0 (monitor only)', async () => {
    const tracker = { maxUsedPercent: () => 99, get: () => null };
    const d = make({ planTracker: tracker as never, planMaxPercent: { claude: 0, codex: 0 } });
    seedTask('p1', 'claude');
    d.tick();
    await flush();
    expect(launcher.calls).toHaveLength(1);
    expect(d.planFor('claude').blocked).toBe(false);
  });

  it('counts extraClaudeTokens toward claude usage', () => {
    const d = make({
      budgets: { claude: { soft: 0, hard: 500 }, codex: { soft: 0, hard: 0 } },
      extraClaudeTokens: () => 600,
    });
    expect(d.budgetFor('claude').level).toBe('hard');
    expect(d.budgetFor('codex').used).toBe(0);
  });

  it('routes failed runs to needs_human with the output tail', async () => {
    const d = make();
    const t = seedTask();
    d.tick();
    await flush();
    launcher.calls[0].resolve(failResult);
    await flush();
    const after = store.getTask(t.id)!;
    expect(after.status).toBe('needs_human');
    expect(store.listRuns(t.id)[0].status).toBe('failed');
    expect(store.listComments(t.id).some(c => c.body.includes('boom stack trace'))).toBe(true);
  });

  it('moves silently-successful runs to review', async () => {
    const d = make();
    const t = seedTask();
    d.tick();
    await flush();
    launcher.calls[0].resolve(okResult);
    await flush();
    expect(store.getTask(t.id)!.status).toBe('review');
    const run = store.listRuns(t.id)[0];
    expect(run.status).toBe('succeeded');
    expect(run.input_tokens).toBe(100);
  });

  it('does not force review on a handed-off task, and re-dispatches it to the other agent', async () => {
    const d = make();
    const t = seedTask();
    d.tick();
    await flush();
    store.updateTask(t.id, { status: 'ready', assignee: 'codex' }); // agent handed off mid-run
    launcher.calls[0].resolve(okResult);
    await flush();
    // completion freed claude + the project, so the handoff dispatches straight to codex
    expect(launcher.calls).toHaveLength(2);
    expect(launcher.calls[1].agent).toBe('codex');
    const after = store.getTask(t.id)!;
    expect(after.status).toBe('in_progress');
    expect(after.assignee).toBe('codex');
    // no "succeeded but did not update the board" comment was posted
    expect(store.listComments(t.id).some(c => c.body.includes('did not update the board'))).toBe(false);
  });

  it('passes per-task model/effort overrides to the launcher', async () => {
    const d = make();
    const p = store.addProject('p1', process.cwd());
    store.createTask({
      project_id: p.id, title: 'heavy task', description: '', assignee: 'claude',
      created_by: 'human', status: 'ready', model: 'opus', effort: 'max',
    });
    d.tick();
    await flush();
    expect(launcher.calls[0].tuning).toEqual({ model: 'opus', effort: 'max' });
  });

  it('passes no tuning when the task has none', async () => {
    const d = make();
    seedTask();
    d.tick();
    await flush();
    expect(launcher.calls[0].tuning).toBeUndefined();
  });

  it('runs both agents in one git project in parallel worktrees, merging on success', async () => {
    const finalized: number[] = [];
    const fakeWt = {
      isGitRepo: () => true,
      create: (_p: string, taskId: number, runId: number) => ({ dir: `wt-${runId}`, branch: `sb/task-${taskId}-run-${runId}` }),
      finalize: (_p: string, h: { branch: string }) => { finalized.push(1); return { merged: true, changed: true, conflictFiles: [] }; },
      abandon: () => ({ changed: false }),
      cleanupOrphans: () => {},
    };
    const d = make({ parallel: true, worktrees: fakeWt as never });
    const t1 = seedTask('p1', 'claude', 'first');
    const t2 = seedTask('p1', 'codex', 'second');
    d.tick();
    await flush();
    // BOTH launched despite sharing a project — in separate worktrees
    expect(launcher.calls).toHaveLength(2);
    expect(new Set(launcher.calls.map(c => c.cwd)).size).toBe(2);
    expect(launcher.calls.every(c => c.cwd.startsWith('wt-'))).toBe(true);
    launcher.calls[0].resolve(okResult);
    launcher.calls[1].resolve(okResult);
    await flush();
    expect(finalized).toHaveLength(2);
    expect(store.getTask(t1.id)!.status).toBe('review');
    expect(store.getTask(t2.id)!.status).toBe('review');
    expect(store.listComments(t1.id).some(c => c.body.includes('Merged parallel branch'))).toBe(true);
  });

  it('parks a task with the conflict details when a parallel merge fails', async () => {
    const fakeWt = {
      isGitRepo: () => true,
      create: (_p: string, taskId: number, runId: number) => ({ dir: `wt-${runId}`, branch: `sb/task-${taskId}-run-${runId}` }),
      finalize: () => ({ merged: false, changed: true, conflictFiles: ['src/app.py'] }),
      abandon: () => ({ changed: false }),
      cleanupOrphans: () => {},
    };
    const d = make({ parallel: true, worktrees: fakeWt as never });
    const t = seedTask('p1', 'claude');
    d.tick();
    await flush();
    launcher.calls[0].resolve(okResult);
    await flush();
    const after = store.getTask(t.id)!;
    expect(after.status).toBe('needs_human');
    expect(store.listComments(t.id).some(c => c.body.includes('src/app.py') && c.body.includes('conflicts'))).toBe(true);
  });

  it('abandons (never merges) the worktree of a failed run', async () => {
    const calls: string[] = [];
    const fakeWt = {
      isGitRepo: () => true,
      create: (_p: string, taskId: number, runId: number) => ({ dir: `wt-${runId}`, branch: `sb/b-${runId}` }),
      finalize: () => { calls.push('finalize'); return { merged: true, changed: false, conflictFiles: [] }; },
      abandon: () => { calls.push('abandon'); return { changed: true }; },
      cleanupOrphans: () => {},
    };
    const d = make({ parallel: true, worktrees: fakeWt as never });
    const t = seedTask('p1', 'claude');
    d.tick();
    await flush();
    launcher.calls[0].resolve(failResult);
    await flush();
    expect(calls).toEqual(['abandon']);
    expect(store.getTask(t.id)!.status).toBe('needs_human');
    expect(store.listComments(t.id).some(c => c.body.includes('partial work preserved on branch'))).toBe(true);
  });

  it('keeps non-git projects serialized even with parallel enabled', async () => {
    const fakeWt = {
      isGitRepo: () => false,
      create: () => { throw new Error('should not be called'); },
      finalize: () => ({ merged: true, changed: false, conflictFiles: [] }),
      abandon: () => ({ changed: false }),
      cleanupOrphans: () => {},
    };
    const d = make({ parallel: true, worktrees: fakeWt as never });
    seedTask('p1', 'claude');
    seedTask('p1', 'codex');
    d.tick();
    await flush();
    expect(launcher.calls).toHaveLength(1);
    expect(launcher.calls[0].cwd).toBe(process.cwd()); // main tree, no worktree
  });

  it('holds tasks with unmet dependencies and dispatches once satisfied', async () => {
    const d = make();
    const dep = seedTask('p1', 'codex', 'prerequisite');
    const t = seedTask('p2', 'claude', 'dependent');
    store.addDependency(t.id, dep.id);
    d.tick();
    await flush();
    // only the prerequisite dispatched; the dependent (different project+agent) was dep-blocked
    expect(launcher.calls).toHaveLength(1);
    expect(launcher.calls[0].prompt).toContain('prerequisite');
    launcher.calls[0].resolve(okResult); // prerequisite → review, dep satisfied
    await flush();
    expect(launcher.calls).toHaveLength(2);
    expect(launcher.calls[1].prompt).toContain('dependent');
  });

  it('holds dependents until the dependency run fully completes, even if its status is already review', async () => {
    const d = make();
    const dep = seedTask('p1', 'codex', 'prerequisite');
    d.tick();
    await flush();
    // agent calls finish_task mid-run: status flips to review while the process is still alive
    store.updateTask(dep.id, { status: 'review' });
    const t = seedTask('p2', 'claude', 'dependent');
    store.addDependency(t.id, dep.id);
    d.tick();
    await flush();
    expect(launcher.calls).toHaveLength(1); // dependent held — dep's run still in flight
    launcher.calls[0].resolve(okResult);
    await flush();
    expect(launcher.calls).toHaveLength(2); // released once the run (and any merge) completed
    expect(launcher.calls[1].prompt).toContain('dependent');
  });

  it('parks tasks with a clear message when the project directory is missing', async () => {
    const d = make();
    const p = store.addProject('ghost', 'Z:/definitely/does/not/exist');
    const t = store.createTask({
      project_id: p.id, title: 'doomed', description: '', assignee: 'claude', created_by: 'human', status: 'ready',
    });
    d.tick();
    await flush();
    expect(launcher.calls).toHaveLength(0); // no spawn attempted, no bounce burned
    const after = store.getTask(t.id)!;
    expect(after.status).toBe('needs_human');
    expect(after.bounce_count).toBe(0);
    expect(store.listComments(t.id)[0].body).toContain('does not exist');
  });

  it('recovers orphaned runs on boot', () => {
    const t = seedTask();
    store.createRun(t.id, 'claude', 'p');
    store.updateTask(t.id, { status: 'in_progress' });
    make().recoverOrphans();
    expect(store.runningRuns()).toHaveLength(0);
    expect(store.listRuns(t.id)[0].status).toBe('failed');
    expect(store.getTask(t.id)!.status).toBe('needs_human');
  });

  it('fails leased runs on boot only when remote dispatch is not configured', () => {
    const t = seedTask('p1', 'codex');
    const run = store.createRun(t.id, 'codex', 'remote');
    store.updateTask(t.id, { status: 'in_progress' });
    store.createLease({ run_id: run.id, worker_id: 'amber', token: 't'.repeat(64), expires_at: Date.now() + 60_000 });
    make().recoverOrphans();
    expect(store.runningRuns()).toHaveLength(1); // default: a coordinator will expire it
    make().recoverOrphans({ remoteEnabled: false });
    expect(store.runningRuns()).toHaveLength(0);
    expect(store.getLease(run.id)?.state).toBe('lost');
    expect(store.getTask(t.id)!.status).toBe('needs_human');
    expect(store.listComments(t.id).at(-1)?.body).toContain('no longer configured');
  });

  it('ticks automatically on bus change events', async () => {
    make();
    seedTask();
    bus.change({ kind: 'task_created' });
    await flush();
    expect(launcher.calls).toHaveLength(1);
  });

  it('captures live output', async () => {
    const d = make();
    seedTask();
    d.tick();
    await flush();
    const active = d.activeRuns()[0];
    expect(d.liveOutput(active.runId)).toContain('fake output');
  });
});
