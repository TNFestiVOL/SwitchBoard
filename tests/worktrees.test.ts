import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeManager } from '../src/worktrees.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });

describe('WorktreeManager', () => {
  let repo: string;
  let mgr: WorktreeManager;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'sb-wt-repo-'));
    git(repo, 'init', '-b', 'main');
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'base');
    mgr = new WorktreeManager(mkdtempSync(join(tmpdir(), 'sb-wt-trees-')));
  });

  it('detects git repos', () => {
    expect(mgr.isGitRepo(repo)).toBe(true);
    expect(mgr.isGitRepo(tmpdir())).toBe(false);
  });

  it('creates a worktree, merges changes back, and cleans up', () => {
    const handle = mgr.create(repo, 7, 101);
    expect(existsSync(handle.dir)).toBe(true);
    writeFileSync(join(handle.dir, 'feature.txt'), 'made in worktree\n');
    const result = mgr.finalize(repo, handle, 'task #7 by codex');
    expect(result).toEqual({ merged: true, changed: true, conflictFiles: [] });
    expect(readFileSync(join(repo, 'feature.txt'), 'utf8')).toContain('made in worktree');
    expect(existsSync(handle.dir)).toBe(false);
  });

  it('baselines a dirty main tree before branching', () => {
    writeFileSync(join(repo, 'uncommitted.txt'), 'serial-era edit\n');
    const handle = mgr.create(repo, 8, 102);
    // the baseline commit captured the dirty file, and the worktree sees it
    expect(existsSync(join(handle.dir, 'uncommitted.txt'))).toBe(true);
    const result = mgr.finalize(repo, handle, 'noop');
    expect(result.merged).toBe(true);
    expect(result.changed).toBe(false); // nothing new in the worktree
  });

  it('reports conflicts, aborts the merge, and keeps the branch', () => {
    const handle = mgr.create(repo, 9, 103);
    writeFileSync(join(handle.dir, 'base.txt'), 'worktree version\n');
    // meanwhile main tree diverges on the same file
    writeFileSync(join(repo, 'base.txt'), 'main version\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'main diverges');
    const result = mgr.finalize(repo, handle, 'task #9 by claude');
    expect(result.merged).toBe(false);
    expect(result.conflictFiles).toEqual(['base.txt']);
    // main tree left clean (merge aborted), work preserved on the branch
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
    expect(git(repo, 'branch', '--list', handle.branch).trim()).toContain(handle.branch);
    expect(readFileSync(join(repo, 'base.txt'), 'utf8')).toContain('main version');
  });

  it('reports a worktree it could not remove instead of failing silently', () => {
    const handle = mgr.create(repo, 9, 103);
    writeFileSync(join(handle.dir, 'feature.txt'), 'merged work\n');
    // A lock is the deterministic stand-in for an open handle on Windows.
    git(repo, 'worktree', 'lock', handle.dir);
    const result = mgr.finalize(repo, handle, 'task #9 by codex');
    expect(result.merged).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.cleanupError).toMatch(/lock/i);
    expect(existsSync(handle.dir)).toBe(true);
    expect(readFileSync(join(repo, 'feature.txt'), 'utf8')).toContain('merged work');
    git(repo, 'worktree', 'unlock', handle.dir);
  });

  it('parallel worktrees on disjoint files both merge cleanly', () => {
    const h1 = mgr.create(repo, 10, 104);
    const h2 = mgr.create(repo, 11, 105);
    writeFileSync(join(h1.dir, 'one.txt'), 'agent one\n');
    writeFileSync(join(h2.dir, 'two.txt'), 'agent two\n');
    expect(mgr.finalize(repo, h1, 'task #10').merged).toBe(true);
    expect(mgr.finalize(repo, h2, 'task #11').merged).toBe(true);
    expect(existsSync(join(repo, 'one.txt'))).toBe(true);
    expect(existsSync(join(repo, 'two.txt'))).toBe(true);
  });
});
