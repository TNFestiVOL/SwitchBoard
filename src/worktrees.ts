import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Git-worktree isolation for parallel agent runs in one project.
 * Each parallel run gets its own worktree on its own branch; when the run
 * completes we commit whatever the agent left uncommitted and merge the branch
 * back into the project's main working tree. A conflict aborts the merge and
 * is reported so the task can be parked for a human; the branch is kept so
 * nothing is lost.
 */

export interface WorktreeHandle {
  dir: string;
  branch: string;
  /** Branch the project was on before this isolated run was created. */
  baseBranch?: string;
}

export interface FinalizeResult {
  merged: boolean;
  changed: boolean;
  conflictFiles: string[];
  /** Set when the worktree directory survived after its branch was merged or preserved. */
  cleanupError?: string;
}

const IDENT = ['-c', 'user.name=Switchboard', '-c', 'user.email=switchboard@localhost'];

const describe = (e: unknown): string => {
  const err = e as { stderr?: string | Buffer; message?: string };
  return (err.stderr?.toString().trim() || err.message || String(e)).trim();
};

export class WorktreeManager {
  constructor(private baseDir: string) {}

  private git(cwd: string, ...args: string[]): string {
    return execFileSync('git', [...IDENT, ...args], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  isGitRepo(projectPath: string): boolean {
    return existsSync(join(projectPath, '.git'));
  }

  currentBranch(projectPath: string): string {
    try {
      return this.git(projectPath, 'branch', '--show-current').trim() || 'HEAD';
    } catch {
      return 'main';
    }
  }

  private isDirty(projectPath: string): boolean {
    return this.git(projectPath, 'status', '--porcelain').trim().length > 0;
  }

  /** Parallel runs branch from HEAD, so uncommitted main-tree work must be committed first. */
  ensureCleanBaseline(projectPath: string): void {
    if (!this.isDirty(projectPath)) return;
    this.git(projectPath, 'add', '-A');
    this.git(projectPath, 'commit', '-m', 'switchboard: baseline before parallel runs');
  }

  create(projectPath: string, taskId: number, runId: number): WorktreeHandle {
    mkdirSync(this.baseDir, { recursive: true });
    const branch = `sb/task-${taskId}-run-${runId}`;
    const dir = join(this.baseDir, `run-${runId}`);
    const baseBranch = this.currentBranch(projectPath);
    this.ensureCleanBaseline(projectPath);
    this.git(projectPath, 'worktree', 'add', dir, '-b', branch);
    return { dir, branch, baseBranch };
  }

  /** Commit the run's changes and merge them into the project's main tree. */
  finalize(projectPath: string, handle: WorktreeHandle, message: string): FinalizeResult {
    // Any error must leave the worktree and branch available for recovery.
    this.git(handle.dir, 'add', '-A');
    const staged = this.git(handle.dir, 'status', '--porcelain').trim().length > 0;
    if (staged) {
      this.git(handle.dir, 'commit', '-m', message);
    }
    // The agent may also have made its own commits — anything ahead of HEAD counts.
    const changed = this.git(projectPath, 'rev-list', '--count', `HEAD..${handle.branch}`).trim() !== '0';

    if (!changed) {
      const cleanupError = this.remove(projectPath, handle, true, true);
      return { merged: true, changed: false, conflictFiles: [], ...(cleanupError ? { cleanupError } : {}) };
    }

    // Merging requires a clean main tree; serial-era edits get baselined first.
    this.ensureCleanBaseline(projectPath);
    try {
      this.git(projectPath, 'merge', '--no-ff', '--no-edit', handle.branch);
      const cleanupError = this.remove(projectPath, handle, true, true);
      return { merged: true, changed: true, conflictFiles: [], ...(cleanupError ? { cleanupError } : {}) };
    } catch {
      let conflictFiles: string[] = [];
      try {
        conflictFiles = this.git(projectPath, 'diff', '--name-only', '--diff-filter=U').trim().split('\n').filter(Boolean);
      } catch { /* best effort */ }
      try {
        this.git(projectPath, 'merge', '--abort');
      } catch { /* nothing to abort */ }
      this.remove(projectPath, handle, false); // keep the branch — the work is on it
      return { merged: false, changed: true, conflictFiles };
    }
  }

  /** Failed/timed-out run: never merge partial work. Preserve it on the branch, drop the worktree. */
  abandon(projectPath: string, handle: WorktreeHandle, message: string): { changed: boolean; cleanupError?: string } {
    // Do not clean up unless every preservation step succeeds.
    this.git(handle.dir, 'add', '-A');
    if (this.git(handle.dir, 'status', '--porcelain').trim().length > 0) {
      this.git(handle.dir, 'commit', '-m', message);
    }
    const changed = this.git(projectPath, 'rev-list', '--count', `HEAD..${handle.branch}`).trim() !== '0';
    const cleanupError = this.remove(projectPath, handle, !changed);
    return { changed, ...(cleanupError ? { cleanupError } : {}) };
  }

  /** Returns a message when the worktree directory could not be removed; the branch is then kept too. */
  private remove(projectPath: string, handle: WorktreeHandle, deleteBranch: boolean, force = false): string | undefined {
    try {
      this.git(projectPath, 'worktree', 'remove', ...(force ? ['--force'] : []), handle.dir);
    } catch (e) {
      // Untracked files, a lock, or an open handle on Windows: leave everything in place and say so.
      return `git worktree remove failed for ${handle.dir}: ${describe(e)}`;
    }
    if (deleteBranch) {
      try { this.git(projectPath, 'branch', '-D', handle.branch); } catch { /* merged branches may already be gone */ }
    }
  }

  /** Prune stale registrations only; surviving worktrees may contain unsaved work. */
  cleanupOrphans(projectPaths: string[]): void {
    for (const p of projectPaths) {
      try {
        if (this.isGitRepo(p)) this.git(p, 'worktree', 'prune');
      } catch { /* best effort */ }
    }
  }
}
