import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Agent, Author, Comment, Project, Run, RunStatus, Task, TaskStatus } from './types.js';

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'inbox',
  assignee TEXT NOT NULL DEFAULT 'human',
  created_by TEXT NOT NULL DEFAULT 'human',
  bounce_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  agent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  prompt TEXT NOT NULL DEFAULT '',
  output_tail TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_estimate REAL NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_deps (
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  depends_on_id INTEGER NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on_id)
);
CREATE TABLE IF NOT EXISTS remote_leases (
  run_id INTEGER PRIMARY KEY REFERENCES runs(id),
  worker_id TEXT NOT NULL,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  disposition TEXT NOT NULL DEFAULT 'review'
);
`;

export interface CreateTaskInput {
  project_id: number;
  title: string;
  description: string;
  assignee: Author;
  created_by: Author;
  status: TaskStatus;
  model?: string | null;
  effort?: string | null;
  worker_id?: string | null;
}

export interface RemoteLease {
  run_id: number; worker_id: string; token: string; expires_at: number;
  state: 'active' | 'completed' | 'lost'; disposition: 'review' | 'needs_human';
}

export interface TaskFilter {
  project_id?: number;
  status?: TaskStatus;
  assignee?: Author;
}

const TASK_UPDATE_KEYS = ['title', 'description', 'status', 'assignee', 'bounce_count'] as const;
type TaskUpdate = Partial<Pick<Task, (typeof TASK_UPDATE_KEYS)[number]>>;

const RUN_FINISH_KEYS = ['status', 'output_tail', 'input_tokens', 'output_tokens', 'cost_estimate'] as const;
type RunFinish = Partial<Pick<Run, (typeof RUN_FINISH_KEYS)[number]>> & { status: RunStatus };

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    const existed = path !== ':memory:' && existsSync(path);
    this.db = new Database(path);
    try {
      if (path !== ':memory:') this.db.pragma('journal_mode = WAL');
      const current = this.db.pragma('user_version', { simple: true }) as number;
      if (existed && current < SCHEMA_VERSION) this.backup(path);
      this.db.exec(SCHEMA);
      this.migrate();
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private backup(path: string): void {
    const directory = join(dirname(path), 'backups');
    mkdirSync(directory, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
    const stem = join(directory, `switchboard-${stamp}`);
    let target = `${stem}.db`;
    for (let suffix = 2; existsSync(target); suffix++) target = `${stem}-${suffix}.db`;
    this.db.prepare('VACUUM INTO ?').run(target);

    const previous = readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && /^switchboard-\d{8}-\d{6}(?:-\d+)?\.db$/.test(entry.name))
      .map(entry => join(directory, entry.name))
      .filter(file => file !== target)
      .map(file => ({ file, modified: statSync(file).mtimeMs }))
      .sort((a, b) => b.modified - a.modified);
    for (const { file } of previous.slice(9)) unlinkSync(file);
  }

  /** Additive migrations for databases created by older versions. */
  private migrate(): void {
    const cols = (this.db.pragma('table_info(tasks)') as { name: string }[]).map(c => c.name);
    if (!cols.includes('model')) this.db.exec('ALTER TABLE tasks ADD COLUMN model TEXT');
    if (!cols.includes('effort')) this.db.exec('ALTER TABLE tasks ADD COLUMN effort TEXT');
    if (!cols.includes('worker_id')) this.db.exec('ALTER TABLE tasks ADD COLUMN worker_id TEXT');
  }

  close(): void {
    this.db.close();
  }

  ping(): void {
    this.db.prepare('SELECT 1').get();
  }

  serverId(): string {
    return this.db.transaction(() => {
      const existing = this.getSetting('server_id', '');
      if (existing) return existing;
      const id = randomUUID();
      this.setSetting('server_id', id);
      return id;
    }).immediate();
  }

  // --- projects ---
  addProject(name: string, path: string): Project {
    const info = this.db.prepare('INSERT INTO projects (name, path) VALUES (?, ?)').run(name, path);
    return this.getProject(Number(info.lastInsertRowid))!;
  }

  listProjects(): Project[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY name').all() as Project[];
  }

  getProject(id: number): Project | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
  }

  getProjectByName(name: string): Project | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE name = ?').get(name) as Project | undefined;
  }

  // --- tasks ---
  createTask(input: CreateTaskInput): Task {
    const info = this.db.prepare(
      `INSERT INTO tasks (project_id, title, description, status, assignee, created_by, model, effort, worker_id)
       VALUES (@project_id, @title, @description, @status, @assignee, @created_by, @model, @effort, @worker_id)`,
    ).run({ model: null, effort: null, worker_id: null, ...input });
    return this.getTask(Number(info.lastInsertRowid))!;
  }

  getTask(id: number): Task | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
  }

  /** Publish the task and all dependency edges as one atomic operation. */
  createTaskWithDependencies(input: CreateTaskInput, deps: number[]): Task {
    return this.db.transaction(() => {
      for (const id of deps) {
        if (!this.getTask(id)) throw new Error(`depends_on refers to missing task ${id}`);
      }
      const task = this.createTask(input);
      for (const id of deps) this.addDependency(task.id, id);
      return task;
    })();
  }

  listTasks(filter: TaskFilter = {}): Task[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.project_id !== undefined) { clauses.push('project_id = @project_id'); params.project_id = filter.project_id; }
    if (filter.status !== undefined) { clauses.push('status = @status'); params.status = filter.status; }
    if (filter.assignee !== undefined) { clauses.push('assignee = @assignee'); params.assignee = filter.assignee; }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at`).all(params) as Task[];
  }

  updateTask(id: number, fields: TaskUpdate): Task {
    const keys = TASK_UPDATE_KEYS.filter(k => fields[k] !== undefined);
    if (keys.length) {
      const sets = keys.map(k => `${k} = @${k}`).join(', ');
      this.db.prepare(
        `UPDATE tasks SET ${sets}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = @id`,
      ).run({ ...fields, id });
    }
    return this.getTask(id)!;
  }

  // --- comments ---
  addComment(task_id: number, author: Author, body: string): Comment {
    const info = this.db.prepare('INSERT INTO comments (task_id, author, body) VALUES (?, ?, ?)').run(task_id, author, body);
    return this.db.prepare('SELECT * FROM comments WHERE id = ?').get(Number(info.lastInsertRowid)) as Comment;
  }

  listComments(task_id: number): Comment[] {
    return this.db.prepare('SELECT * FROM comments WHERE task_id = ? ORDER BY id').all(task_id) as Comment[];
  }

  // --- runs ---
  createRun(task_id: number, agent: Agent, prompt: string): Run {
    const info = this.db.prepare('INSERT INTO runs (task_id, agent, prompt) VALUES (?, ?, ?)').run(task_id, agent, prompt);
    return this.getRun(Number(info.lastInsertRowid))!;
  }

  getRun(id: number): Run | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Run | undefined;
  }

  setRunPrompt(id: number, prompt: string): void {
    this.db.prepare('UPDATE runs SET prompt = ? WHERE id = ?').run(prompt, id);
  }

  finishRun(id: number, fields: RunFinish): Run {
    const keys = RUN_FINISH_KEYS.filter(k => fields[k] !== undefined);
    const sets = keys.map(k => `${k} = @${k}`).join(', ');
    this.db.prepare(
      `UPDATE runs SET ${sets}, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = @id`,
    ).run({ ...fields, id });
    return this.getRun(id)!;
  }

  listRuns(task_id?: number): Run[] {
    if (task_id !== undefined) {
      return this.db.prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY id').all(task_id) as Run[];
    }
    return this.db.prepare('SELECT * FROM runs ORDER BY id').all() as Run[];
  }

  runningRuns(): Run[] {
    return this.db.prepare("SELECT * FROM runs WHERE status = 'running' ORDER BY id").all() as Run[];
  }

  runsSince(iso: string): Run[] {
    return this.db.prepare('SELECT * FROM runs WHERE started_at >= ? ORDER BY id').all(iso) as Run[];
  }

  // --- dependencies ---
  addDependency(task_id: number, depends_on_id: number): void {
    this.db.prepare('INSERT OR IGNORE INTO task_deps (task_id, depends_on_id) VALUES (?, ?)').run(task_id, depends_on_id);
  }

  listDependencies(task_id: number): number[] {
    return (this.db.prepare('SELECT depends_on_id FROM task_deps WHERE task_id = ? ORDER BY depends_on_id').all(task_id) as { depends_on_id: number }[])
      .map(r => r.depends_on_id);
  }

  /** Dependency ids not yet satisfied (a dep counts as satisfied once it reaches review or done). */
  unmetDependencies(task_id: number): number[] {
    return (this.db.prepare(
      `SELECT d.depends_on_id FROM task_deps d JOIN tasks t ON t.id = d.depends_on_id
       WHERE d.task_id = ? AND t.status NOT IN ('review','done') ORDER BY d.depends_on_id`,
    ).all(task_id) as { depends_on_id: number }[]).map(r => r.depends_on_id);
  }

  // --- settings ---
  transaction<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }

  createLease(lease: Pick<RemoteLease, 'run_id' | 'worker_id' | 'token' | 'expires_at'>): void {
    this.db.prepare('INSERT INTO remote_leases (run_id, worker_id, token, expires_at) VALUES (@run_id, @worker_id, @token, @expires_at)').run(lease);
  }

  getLease(runId: number): RemoteLease | undefined {
    return this.db.prepare('SELECT * FROM remote_leases WHERE run_id = ?').get(runId) as RemoteLease | undefined;
  }

  activeLeases(): RemoteLease[] {
    return this.db.prepare("SELECT * FROM remote_leases WHERE state = 'active'").all() as RemoteLease[];
  }

  updateLease(runId: number, expiresAt: number, state: RemoteLease['state'], disposition?: RemoteLease['disposition']): void {
    this.db.prepare('UPDATE remote_leases SET expires_at = ?, state = ?, disposition = COALESCE(?, disposition) WHERE run_id = ?')
      .run(expiresAt, state, disposition ?? null, runId);
  }

  setRunOutput(runId: number, output: string): void {
    this.db.prepare('UPDATE runs SET output_tail = ? WHERE id = ?').run(output.slice(-20_000), runId);
  }

  getSetting(key: string, dflt: string): string {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? dflt;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}
