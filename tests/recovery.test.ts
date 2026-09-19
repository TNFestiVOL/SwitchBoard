import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { EventBus } from '../src/events.js';
import { Dispatcher } from '../src/dispatcher.js';
import { toolHandlers } from '../src/tools.js';
import { WorktreeManager, type FinalizeResult } from '../src/worktrees.js';
import type { RunResult } from '../src/launcher.js';

const ok: RunResult = { ok: true, timedOut: false, exitCode: 0, outputTail: 'ok', inputTokens: 0, outputTokens: 0, costEstimate: 0 };
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function setup() {
  const store = new Store(':memory:');
  const bus = new EventBus();
  const calls: { cwd: string; prompt: string; resolve: (r: RunResult) => void }[] = [];
  const launcher = { launch: (_agent: unknown, prompt: string, cwd: string) => new Promise<RunResult>(resolve => calls.push({ cwd, prompt, resolve })) };
  const wt = {
    isGitRepo: () => true,
    create: (_p: string, _t: number, r: number) => ({ dir: `isolated-${r}`, branch: `branch-${r}` }),
    finalize: vi.fn<() => FinalizeResult>(() => ({ merged: true, changed: true, conflictFiles: [] })),
    abandon: vi.fn(() => ({ changed: true })),
    cleanupOrphans: () => {},
  };
  const dispatcher = new Dispatcher(store, launcher, bus, { budgets: {}, bounceCap: 6, parallel: true, worktrees: wt as unknown as WorktreeManager });
  store.addProject('p', process.cwd());
  return { store, bus, calls, wt, dispatcher, h: toolHandlers(store, bus, 'claude') };
}

describe('dispatcher failure boundaries', () => {
  it('waits for a handoff to land and records the actual worktree in its prompt', async () => {
    const s = setup();
    const t = s.h.create_task({ project: 'p', title: 'handoff', assignee: 'claude' });
    s.wt.finalize.mockImplementation(() => {
      expect(s.store.runningRuns()).toHaveLength(1);
      return { merged: true, changed: true, conflictFiles: [] };
    });
    s.h.assign_task({ id: t.id, assignee: 'codex' });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].prompt).toContain(`Your working directory is: ${s.calls[0].cwd}`);
    expect(s.store.listRuns(t.id)[0].prompt).toBe(s.calls[0].prompt);
    s.calls[0].resolve(ok);
    await flush();
    expect(s.wt.finalize).toHaveBeenCalledOnce();
    expect(s.calls).toHaveLength(2);
    s.store.close();
  });

  it.each(['review', 'done', 'ready'] as const)('parks a failed run even after the task becomes %s', async status => {
    const s = setup();
    const t = s.h.create_task({ project: 'p', title: 'parent', assignee: 'claude' });
    const child = s.h.create_task({ project: 'p', title: 'child', assignee: 'codex', depends_on: [t.id] });
    s.h.update_status({ id: t.id, status });
    s.calls[0].resolve({ ...ok, ok: false, timedOut: true, exitCode: null });
    await flush();
    expect(s.store.getTask(t.id)?.status).toBe('needs_human');
    expect(s.store.getTask(child.id)?.status).toBe('ready');
    expect(s.calls).toHaveLength(1);
    expect(s.wt.abandon).toHaveBeenCalledOnce();
    s.store.close();
  });

  it('parks finalization errors and blocks dependents', async () => {
    const s = setup();
    s.wt.finalize.mockImplementation(() => { throw new Error('commit failed'); });
    const t = s.h.create_task({ project: 'p', title: 'parent', assignee: 'claude' });
    s.h.create_task({ project: 'p', title: 'child', assignee: 'codex', depends_on: [t.id] });
    s.h.finish_task({ id: t.id, summary: 'done' });
    s.calls[0].resolve(ok);
    await flush();
    expect(s.store.getTask(t.id)?.status).toBe('needs_human');
    expect(s.store.listRuns(t.id)[0].status).toBe('failed');
    expect(s.dispatcher.activeRuns()).toHaveLength(0);
    expect(s.calls).toHaveLength(1);
    s.store.close();
  });

  it('tells the human when a merged worktree could not be removed', async () => {
    const s = setup();
    const t = s.h.create_task({ project: 'p', title: 'leaky', assignee: 'claude' });
    s.wt.finalize.mockImplementation(() => ({ merged: true, changed: true, conflictFiles: [], cleanupError: 'git worktree remove failed: locked' }));
    await flush();
    s.calls[0].resolve(ok);
    await flush();
    const bodies = s.store.listComments(t.id).map(c => c.body);
    expect(bodies.some(b => b.includes('left behind') && b.includes('worktree remove --force'))).toBe(true);
    expect(s.store.getTask(t.id)?.status).toBe('review');
  });

  it.each(['review', 'ready', 'done'] as const)('parks orphaned runs whose task was already %s', status => {
    const s = setup();
    s.store.setSetting('paused', '1');
    const t = s.h.create_task({ project: 'p', title: 'orphan', assignee: 'claude' });
    s.store.createRun(t.id, 'claude', 'old');
    s.store.updateTask(t.id, { status });
    s.dispatcher.recoverOrphans();
    expect(s.store.getTask(t.id)?.status).toBe('needs_human');
    expect(s.store.runningRuns()).toHaveLength(0);
    s.store.close();
  });

  it('rejects invalid dependencies without leaving a runnable task', () => {
    const s = setup();
    expect(() => s.h.create_task({ project: 'p', title: 'bad', assignee: 'claude', depends_on: [999] })).toThrow(/missing task/);
    s.dispatcher.tick();
    expect(s.store.listTasks()).toHaveLength(0);
    expect(s.calls).toHaveLength(0);
    s.store.close();
  });

  it('rolls back the task and earlier edges when an edge insertion fails', () => {
    const s = setup();
    s.store.setSetting('paused', '1');
    const a = s.h.create_task({ project: 'p', title: 'a', assignee: 'human' });
    const b = s.h.create_task({ project: 'p', title: 'b', assignee: 'human' });
    const original = s.store.addDependency.bind(s.store);
    vi.spyOn(s.store, 'addDependency').mockImplementation((id, dep) => {
      if (dep === b.id) throw new Error('write failed');
      original(id, dep);
    });
    expect(() => s.h.create_task({ project: 'p', title: 'bad', assignee: 'claude', depends_on: [a.id, b.id] })).toThrow('write failed');
    expect(s.store.listTasks()).toHaveLength(2);
    expect(s.store.listDependencies(b.id + 1)).toEqual([]);
    s.store.close();
  });
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'sb-recovery-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  writeFileSync(join(repo, 'base.txt'), 'base');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'base');
  const manager = new WorktreeManager(join(root, 'worktrees'));
  const handle = manager.create(repo, 1, 1);
  writeFileSync(join(handle.dir, 'unsaved.txt'), 'preserve me');
  return { repo, manager, handle };
}

describe('worktree preservation with real git', () => {
  it.each(['finalize', 'abandon'] as const)('preserves files and branch when %s cannot commit', method => {
    const { repo, manager, handle } = repository();
    // A real failing hook exercises successful staging followed by failed commit.
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(() => manager[method](repo, handle, 'save')).toThrow();
    expect(readFileSync(join(handle.dir, 'unsaved.txt'), 'utf8')).toBe('preserve me');
    expect(git(repo, 'branch', '--list', handle.branch)).toContain(handle.branch);
  });

  it('retains uncommitted files and worktree registration across restart cleanup', () => {
    const { repo, manager, handle } = repository();
    manager.cleanupOrphans([repo]);
    expect(readFileSync(join(handle.dir, 'unsaved.txt'), 'utf8')).toBe('preserve me');
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(handle.branch);
    expect(existsSync(join(handle.dir, '.git'))).toBe(true);
  });
});
