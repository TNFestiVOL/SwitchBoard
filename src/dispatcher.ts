import { existsSync } from 'node:fs';
import type { Store } from './store.js';
import type { EventBus } from './events.js';
import type { Launcher, RunResult } from './launcher.js';
import { buildPrompt } from './prompt.js';
import { WINDOW_MS, budgetLevel, windowUsage, type BudgetLevel } from './budget.js';
import type { PlanUsage, PlanUsageTracker } from './plan-usage.js';
import type { WorktreeHandle, WorktreeManager } from './worktrees.js';
import { AGENTS, type Agent, type Project, type RunStatus, type Task } from './types.js';

export interface DispatcherOpts {
  budgets: Partial<Record<Agent, { soft: number; hard: number }>>;
  bounceCap: number;
  /** Hook for the Claude transcript estimator: extra tokens to count toward claude's window. */
  extraClaudeTokens?: () => number;
  /** True plan usage (CLI /usage and /status equivalents). Optional. */
  planTracker?: PlanUsageTracker;
  /** Stop dispatching an agent when any plan window reaches this percent. 0 = monitor only. */
  planMaxPercent?: Partial<Record<Agent, number>>;
  /** Allow both agents to work the same git project simultaneously, each in its own worktree. */
  parallel?: boolean;
  worktrees?: WorktreeManager;
  /** Concurrent runs allowed per agent (default 1 each). >1 spawns multiple instances of that CLI. */
  agentConcurrency?: Partial<Record<Agent, number>>;
}

interface InFlight {
  runId: number;
  taskId: number;
  agent: Agent;
  projectId: number;
  projectPath: string;
  buffer: string;
  handle?: WorktreeHandle;
}

const LIVE_BUFFER_LIMIT = 20_000;
const COMMENT_TAIL_LIMIT = 2_000;

export class Dispatcher {
  private inFlight = new Map<number, InFlight>();
  private ticking = false;
  private tickAgain = false;

  constructor(
    private store: Store,
    private launcher: Launcher,
    private bus: EventBus,
    private opts: DispatcherOpts,
  ) {
    // Board mutations wake the dispatcher — this is what makes the board "live".
    bus.onChange(() => this.tick());
  }

  activeRuns(): { runId: number; taskId: number; agent: Agent }[] {
    const local = [...this.inFlight.values()].map(({ runId, taskId, agent }) => ({ runId, taskId, agent }));
    const remote = this.store.runningRuns().filter(r => this.store.getLease(r.id)?.state === 'active')
      .map(r => ({ runId: r.id, taskId: r.task_id, agent: r.agent }));
    return [...local, ...remote];
  }

  liveOutput(runId: number): string | undefined {
    const local = this.inFlight.get(runId)?.buffer;
    if (local !== undefined) return local;
    const run = this.store.getRun(runId);
    return run?.status === 'running' && this.store.getLease(runId)?.state === 'active' ? run.output_tail : undefined;
  }

  budgetFor(agent: Agent): { used: number; soft: number; hard: number; level: BudgetLevel } {
    const now = new Date();
    const since = new Date(now.getTime() - WINDOW_MS).toISOString();
    let used = windowUsage(this.store.runsSince(since), agent, now);
    if (agent === 'claude' && this.opts.extraClaudeTokens) used += this.opts.extraClaudeTokens();
    const { soft, hard } = this.opts.budgets[agent] ?? { soft: 0, hard: 0 };
    return { used, soft, hard, level: budgetLevel(used, soft, hard) };
  }

  planFor(agent: Agent): { usage: PlanUsage | null; maxPercent: number; blocked: boolean } {
    const maxPercent = this.opts.planMaxPercent?.[agent] ?? 0;
    const usage = this.opts.planTracker?.get(agent) ?? null;
    const used = this.opts.planTracker?.maxUsedPercent(agent) ?? 0;
    return { usage, maxPercent, blocked: maxPercent > 0 && used >= maxPercent };
  }

  /**
   * Boot-time recovery. Local runs that were mid-flight when the process died are failed and
   * parked. Runs leased to a remote worker are left to the coordinator, which resumes expiring
   * them; without one (remote config removed) they would otherwise stay "running" forever.
   */
  recoverOrphans(opts: { remoteEnabled?: boolean } = {}): void {
    try {
      this.opts.worktrees?.cleanupOrphans(this.store.listProjects().map(p => p.path));
    } catch { /* best effort */ }
    for (const run of this.store.runningRuns()) {
      const lease = this.store.getLease(run.id);
      if (lease && opts.remoteEnabled !== false) continue; // remote coordinator owns lease recovery
      this.store.finishRun(run.id, { status: 'failed', output_tail: run.output_tail || '[orphaned: process restarted mid-run]' });
      this.store.setRunUncertain(run.id, lease
        ? `leased to worker ${lease.worker_id}; remote dispatch is no longer configured`
        : 'orphaned by a Switchboard restart; the CLI may still be running');
      if (lease) this.store.updateLease(run.id, Date.now(), 'lost');
      const task = this.store.getTask(run.task_id);
      if (task) {
        this.store.addComment(task.id, 'human', lease
          ? `Run ${run.id} was leased to remote worker ${lease.worker_id}, but remote dispatch is no longer configured, so it cannot be resumed from here. Check that PC for surviving work.`
          : `Run ${run.id} was orphaned by a Switchboard restart; task needs review. Any surviving worktree and branch have been preserved.`);
        this.store.updateTask(task.id, { status: 'needs_human' });
      }
    }
  }

  tick(): void {
    if (this.ticking) {
      this.tickAgain = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.tickAgain = false;
        this.tickOnce();
      } while (this.tickAgain);
    } finally {
      this.ticking = false;
    }
  }

  private tickOnce(): void {
    if (this.store.getSetting('paused', '0') === '1') return;

    const runsByProject = new Map<number, number>();
    const runsByAgent = new Map<Agent, number>();
    for (const f of this.inFlight.values()) {
      runsByProject.set(f.projectId, (runsByProject.get(f.projectId) ?? 0) + 1);
      runsByAgent.set(f.agent, (runsByAgent.get(f.agent) ?? 0) + 1);
    }
    const slots = (a: Agent): number => Math.max(1, this.opts.agentConcurrency?.[a] ?? 1);
    const totalSlots = AGENTS.reduce((n, a) => n + slots(a), 0);
    const inFlightTasks = new Set(this.store.runningRuns().map(r => r.task_id));

    for (const task of this.store.listTasks({ status: 'ready' })) {
      if (task.worker_id) continue;
      if (inFlightTasks.has(task.id)) continue;
      if (!(AGENTS as string[]).includes(task.assignee)) continue;
      const agent = task.assignee as Agent;
      if ((runsByAgent.get(agent) ?? 0) >= slots(agent)) continue;
      if (this.budgetFor(agent).level !== 'ok') continue;
      if (this.planFor(agent).blocked) continue;
      if (this.store.unmetDependencies(task.id).length > 0) continue;
      // An agent may finish_task (→ review) while its run is still finalizing — the worktree
      // merge hasn't landed yet. Don't dispatch dependents until the dep's run fully completes.
      if (this.store.listDependencies(task.id).some(d => inFlightTasks.has(d))) continue;
      if (this.store.listDependencies(task.id).some(id => {
        const dep = this.store.getTask(id)!;
        return dep.worker_id && dep.status !== 'done';
      })) continue;

      const project = this.store.getProject(task.project_id);
      if (!project) continue;
      // Parallel mode: both agents may share a git project, each isolated in a worktree.
      // Otherwise (or for non-git projects) the project stays strictly serialized.
      const useWorktree = !!(this.opts.parallel && this.opts.worktrees?.isGitRepo(project.path));
      const running = runsByProject.get(task.project_id) ?? 0;
      if (useWorktree ? running >= totalSlots : running > 0) continue;

      if (task.bounce_count >= this.opts.bounceCap) {
        this.store.addComment(task.id, 'human',
          `Bounce cap reached (${task.bounce_count} dispatches without resolution). Pausing this task for human review.`);
        this.store.updateTask(task.id, { status: 'needs_human' });
        this.bus.change({ kind: 'bounce_cap', taskId: task.id });
        continue;
      }

      this.dispatch(task, agent, project, useWorktree);
      runsByProject.set(task.project_id, running + 1);
      runsByAgent.set(agent, (runsByAgent.get(agent) ?? 0) + 1);
    }
  }

  private dispatch(task: Task, agent: Agent, project: Project, useWorktree: boolean): void {
    // A missing working directory makes spawn fail with a cryptic cmd.exe ENOENT —
    // catch it here with a clear message and without burning a bounce.
    if (!existsSync(project.path)) {
      this.store.addComment(task.id, 'human',
        `Cannot dispatch: project directory "${project.path}" does not exist. Create it (or fix the project path), then set this task back to ready.`);
      this.store.updateTask(task.id, { status: 'needs_human' });
      this.bus.change({ kind: 'bad_project_path', taskId: task.id });
      return;
    }

    this.store.updateTask(task.id, { status: 'in_progress', bounce_count: task.bounce_count + 1 });
    const run = this.store.createRun(task.id, agent, '');

    const flight: InFlight = { runId: run.id, taskId: task.id, agent, projectId: task.project_id, projectPath: project.path, buffer: '' };

    let cwd = project.path;
    if (useWorktree && this.opts.worktrees) {
      try {
        flight.handle = this.opts.worktrees.create(project.path, task.id, run.id);
        cwd = flight.handle.dir;
      } catch (e) {
        this.store.finishRun(run.id, { status: 'failed', output_tail: `[worktree] ${String(e)}` });
        this.store.addComment(task.id, 'human', `Could not create a worktree for parallel execution: ${String(e)}. Task parked.`);
        this.store.updateTask(task.id, { status: 'needs_human' });
        this.bus.change({ kind: 'run_finished', taskId: task.id });
        return;
      }
    }

    const prompt = buildPrompt({ task, project: { ...project, path: cwd }, agent, comments: this.store.listComments(task.id) });
    this.store.setRunPrompt(run.id, prompt);
    this.inFlight.set(run.id, flight);
    this.bus.change({ kind: 'run_started', taskId: task.id });

    const tuning = task.model || task.effort
      ? { ...(task.model ? { model: task.model } : {}), ...(task.effort ? { effort: task.effort } : {}) }
      : undefined;
    const baseBranch = flight.handle?.baseBranch ?? (
      typeof this.opts.worktrees?.currentBranch === 'function'
        ? this.opts.worktrees.currentBranch(project.path)
        : 'main'
    );
    this.launcher
      .launch(agent, prompt, cwd, chunk => {
        flight.buffer = (flight.buffer + chunk).slice(-LIVE_BUFFER_LIMIT);
      }, tuning, { task, baseBranch })
      .then(result => this.complete(flight, result))
      .catch(err => this.complete(flight, {
        ok: false, timedOut: false, exitCode: null,
        outputTail: `[launcher] ${String(err)}`, inputTokens: 0, outputTokens: 0, costEstimate: 0,
      }));
  }

  private complete(flight: InFlight, result: RunResult): void {
    const status: RunStatus = result.timedOut ? 'timeout' : result.ok ? 'succeeded' : 'failed';
    // Worktree runs must land their changes back in the main tree (or be preserved on failure).
    let mergeConflict: string[] | null = null;
    let finalizationFailed = false;
    let cleanupError: string | undefined;
    if (flight.handle && this.opts.worktrees) {
      const wt = this.opts.worktrees;
      try {
        if (result.ok) {
          const fin = wt.finalize(flight.projectPath, flight.handle, `switchboard: task #${flight.taskId} by ${flight.agent}`);
          cleanupError = fin.cleanupError;
          if (!fin.merged) {
            mergeConflict = fin.conflictFiles;
          } else if (fin.changed) {
            this.store.addComment(flight.taskId, 'human', `Merged parallel branch ${flight.handle.branch} into the main tree.`);
          }
        } else {
          const ab = wt.abandon(flight.projectPath, flight.handle, `switchboard: partial work, task #${flight.taskId} (${status})`);
          cleanupError = ab.cleanupError;
          if (ab.changed) {
            this.store.addComment(flight.taskId, 'human', `Run ${status} — partial work preserved on branch ${flight.handle.branch} (not merged).`);
          }
        }
      } catch (e) {
        finalizationFailed = true;
        this.store.addComment(flight.taskId, 'human', `[worktree] finalize error: ${String(e)}. Worktree ${flight.handle.dir} and branch ${flight.handle.branch} require manual review.`);
      }
    }

    if (cleanupError && flight.handle) {
      console.warn(`[worktree] ${cleanupError}`);
      this.store.addComment(flight.taskId, 'human',
        `Worktree ${flight.handle.dir} was left behind (${cleanupError}). Nothing is lost: branch ${flight.handle.branch} holds the work. ` +
        `Remove it manually with: git worktree remove --force "${flight.handle.dir}"`);
    }

    const task = this.store.getTask(flight.taskId);
    if (task && finalizationFailed) {
      this.store.updateTask(task.id, { status: 'needs_human' });
    } else if (task && mergeConflict) {
      this.store.addComment(task.id, 'human',
        `Parallel run finished but merging branch ${flight.handle!.branch} conflicts with the main tree (files: ${mergeConflict.join(', ') || 'unknown'}). ` +
        'The work is preserved on that branch — resolve the merge manually, then update the task status.');
      this.store.updateTask(task.id, { status: 'needs_human' });
    } else if (task) {
      if (!result.ok) {
        const tail = result.outputTail.slice(-COMMENT_TAIL_LIMIT) || '(no output)';
        this.store.addComment(task.id, 'human',
          `Run ${flight.runId} (${flight.agent}) ${status === 'timeout' ? 'timed out' : `failed (exit ${result.exitCode})`}. Output tail:\n${tail}`);
        this.store.updateTask(task.id, { status: 'needs_human' });
      } else if (task.status === 'in_progress') {
        // Agent finished without calling finish_task/assign_task — surface the output for review.
        const tail = result.outputTail.slice(-COMMENT_TAIL_LIMIT) || '(no output)';
        this.store.addComment(task.id, 'human',
          `Run ${flight.runId} (${flight.agent}) succeeded but did not update the board. Output tail:\n${tail}`);
        this.store.updateTask(task.id, { status: 'review' });
      }
    }

    // Keep the persisted run recoverable until finalization and task updates finish.
    if (result.uncertain) this.store.setRunUncertain(flight.runId, result.uncertain);
    this.store.finishRun(flight.runId, {
      status: result.ok && (finalizationFailed || mergeConflict) ? 'failed' : status,
      output_tail: result.outputTail,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      cost_estimate: result.costEstimate,
    });
    this.inFlight.delete(flight.runId);
    this.bus.change({ kind: 'run_finished', taskId: flight.taskId });
  }
}
