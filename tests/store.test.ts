import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_VERSION, Store } from '../src/store.js';

describe('Store host contract', () => {
  let dir: string;
  let path: string;
  const handles: { close(): void }[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sb-store-'));
    path = join(dir, 'switchboard.db');
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const handle of handles.splice(0).reverse()) handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function openStore(dbPath = path): Store {
    const store = new Store(dbPath);
    handles.push(store);
    return store;
  }

  function openDatabase(dbPath = path): Database.Database {
    const db = new Database(dbPath);
    handles.push(db);
    return db;
  }

  function legacyDatabase(): Database.Database {
    const db = openDatabase();
    db.pragma('journal_mode = WAL');
    db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL); INSERT INTO tasks VALUES (1, 'Before migration')");
    return db;
  }

  function backups(): string[] {
    return readdirSync(join(dir, 'backups')).filter(name => /^switchboard-\d{8}-\d{6}(?:-\d+)?\.db$/.test(name));
  }

  it('backs up an existing unversioned database before migration, including WAL data', () => {
    const legacy = legacyDatabase();
    openStore();

    expect(backups()).toHaveLength(1);
    const backup = openDatabase(join(dir, 'backups', backups()[0]));
    expect(backup.prepare('SELECT * FROM tasks').all()).toEqual([{ id: 1, title: 'Before migration' }]);
    expect(backup.pragma('table_info(tasks)')).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'model' })]));
    expect(backup.pragma('user_version', { simple: true })).toBe(0);
    expect(backup.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(SCHEMA_VERSION).toBe(3);
    expect(legacy.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(legacy.pragma('table_info(tasks)')).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'model' })]));
  });

  it('does not create another backup when reopening the current schema version', () => {
    legacyDatabase().close();
    openStore().close();
    const first = backups();
    expect(first).toHaveLength(1);

    openStore();

    expect(backups()).toEqual(first);
  });

  it('backs up version 1 exactly once before migrating to the current version', () => {
    const original = openStore();
    original.addProject('keep', '/keep');
    original.close();
    const db = openDatabase();
    db.exec('DROP TABLE IF EXISTS operations');
    db.pragma('user_version = 1');

    openStore().close();

    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    const first = backups();
    expect(first).toHaveLength(1);
    const backup = openDatabase(join(dir, 'backups', first[0]));
    expect(backup.pragma('user_version', { simple: true })).toBe(1);
    expect(backup.prepare("SELECT name FROM sqlite_master WHERE name = 'operations'").get()).toBeUndefined();
    expect(backup.prepare('SELECT name FROM projects').all()).toEqual([{ name: 'keep' }]);
    expect(openStore().getProjectByName('keep')?.path).toBe('/keep');
    expect(backups()).toEqual(first);
  });

  it('backs up version 2 exactly once before migrating to version 3', () => {
    const original = openStore();
    original.addProject('keep', '/keep');
    original.close();
    const db = openDatabase();
    db.exec('DROP TABLE IF EXISTS workers');
    for (const column of ['uncertain', 'reconciled_at', 'reconciled_by']) {
      const columns = db.pragma('table_info(runs)') as { name: string }[];
      if (columns.some(c => c.name === column)) db.exec(`ALTER TABLE runs DROP COLUMN ${column}`);
    }
    db.pragma('user_version = 2');

    const migrated = openStore();
    expect(db.pragma('user_version', { simple: true })).toBe(3);
    expect(migrated.listWorkers()).toEqual([]);
    expect(db.pragma('table_info(runs)')).toEqual(expect.arrayContaining(
      ['uncertain', 'reconciled_at', 'reconciled_by'].map(name => expect.objectContaining({ name, type: 'TEXT' })),
    ));
    const first = backups();
    expect(first).toHaveLength(1);
    const backup = openDatabase(join(dir, 'backups', first[0]));
    expect(backup.pragma('user_version', { simple: true })).toBe(2);
    expect(backup.prepare("SELECT name FROM sqlite_master WHERE name = 'workers'").get()).toBeUndefined();
    expect(backup.prepare('SELECT name FROM projects').all()).toEqual([{ name: 'keep' }]);
    migrated.close();
    expect(openStore().getProjectByName('keep')?.path).toBe('/keep');
    expect(backups()).toEqual(first);
  });

  it('persists worker contacts, advertised lists, and the last success independently', () => {
    const store = openStore();
    store.touchWorker('alpha', 'claim', 100, { agents: ['codex'], projects: ['demo', 'second'] });
    store.markWorkerSuccess('alpha', 110);
    store.touchWorker('alpha', 'heartbeat', 120);
    store.touchWorker('beta', 'exited', 130);
    store.close();
    const reopened = openStore();
    expect(reopened.listWorkers()).toEqual([
      { worker_id: 'alpha', last_contact_at: 120, last_contact_kind: 'heartbeat', agents: ['codex'], projects: ['demo', 'second'], last_success_at: 110 },
      { worker_id: 'beta', last_contact_at: 130, last_contact_kind: 'exited', agents: [], projects: [], last_success_at: null },
    ]);
    reopened.touchWorker('alpha', 'claim', 140, { agents: [], projects: [] });
    expect(reopened.listWorkers()[0]).toMatchObject({ agents: [], projects: [], last_success_at: 110 });
  });

  it('persists uncertainty and reconciliation without changing run or task outcomes', () => {
    const store = openStore();
    const project = store.addProject('demo', '/demo');
    const task = store.createTask({ project_id: project.id, title: 'work', description: '', assignee: 'codex', created_by: 'human', status: 'needs_human' });
    const run = store.createRun(task.id, 'codex', 'prompt');
    expect(run).toMatchObject({ uncertain: null, reconciled_at: null, reconciled_by: null });
    store.finishRun(run.id, { status: 'failed', output_tail: 'preserve output' });
    store.setRunUncertain(run.id, 'the process may still be running');
    store.close();
    const reopened = openStore();
    const uncertain = reopened.getRun(run.id)!;
    expect(reopened.listUncertainRuns()).toEqual([uncertain]);
    expect(reopened.runningRuns()).toEqual([]);
    reopened.reconcileRun(run.id, 'worker:alpha', '2026-09-19T12:00:00Z');
    expect(reopened.listUncertainRuns()).toEqual([]);
    expect(reopened.getRun(run.id)).toEqual({ ...uncertain, reconciled_by: 'worker:alpha', reconciled_at: '2026-09-19T12:00:00Z' });
    expect(reopened.getTask(task.id)).toEqual(task);
  });

  it('round-trips operations across reopening and keys them by actor and client_id', () => {
    const store = openStore();
    const operation = {
      actor: 'human', client_id: 'retry_1', operation: 'add_comment',
      body_hash: 'a'.repeat(64), result: JSON.stringify({ id: 42, body: 'saved' }),
    };
    expect(store.getOperation('human', 'retry_1')).toBeUndefined();
    store.recordOperation(operation);
    store.recordOperation({ ...operation, actor: 'another', result: '{}' });
    expect(() => store.recordOperation(operation)).toThrow(/UNIQUE/);
    store.close();

    const reopened = openStore();
    expect(reopened.getOperation('human', 'retry_1')).toEqual({ ...operation, created_at: expect.any(String) });
    expect(reopened.getOperation('human', 'retry_1')?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(reopened.getOperation('another', 'retry_1')?.result).toBe('{}');
    expect(reopened.getOperation('human', 'missing')).toBeUndefined();
  });

  it('stamps a brand-new database without creating a backups directory', () => {
    openStore();

    expect(openDatabase().pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(existsSync(join(dir, 'backups'))).toBe(false);
  });

  it('stamps an in-memory database without writing a backup', () => {
    const store = openStore(':memory:');

    expect(store['db'].pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(store['db'].pragma('database_list')).toEqual([expect.objectContaining({ name: 'main', file: '' })]);
    expect(readdirSync(dir)).toEqual([]);
    const vacuum = vi.spyOn(Database.prototype, 'prepare');
    try {
      openStore(':memory:');
      expect(vacuum.mock.calls.some(([sql]) => /VACUUM/i.test(sql))).toBe(false);
    } finally {
      vacuum.mockRestore();
    }
  });

  it('pings while open and throws after close', () => {
    const store = openStore();
    expect(() => store.ping()).not.toThrow();
    store.close();
    expect(() => store.ping()).toThrow();
  });

  it('persists a stable server UUID across calls and reopening', () => {
    const store = openStore();
    const id = store.serverId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.serverId()).toBe(id);
    expect(store.getSetting('server_id', '')).toBe(id);
    store.close();

    expect(openStore().serverId()).toBe(id);
  });

  it('preserves colliding backup names and retains the newest ten snapshots', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-19T12:34:56Z'));
    const legacy = legacyDatabase();
    openStore().close();
    const first = backups()[0];
    const stem = first.replace(/\.db$/, '');
    const unrelated = join(dir, 'backups', 'manual.db');
    writeFileSync(unrelated, 'keep me');

    for (let n = 2; n <= 12; n++) {
      const previous = backups();
      legacy.pragma('user_version = 0');
      legacy.prepare('UPDATE tasks SET title = ?').run(`Snapshot ${n}`);
      openStore().close();
      const added = backups().filter(name => !previous.includes(name));
      expect(added).toHaveLength(1);
      const backup = openDatabase(join(dir, 'backups', added[0]));
      expect(backup.prepare('SELECT title FROM tasks').get()).toEqual({ title: `Snapshot ${n}` });
      backup.close();
      if (n === 2) {
        expect(added[0]).toBe(`${stem}-2.db`);
        const original = openDatabase(join(dir, 'backups', first));
        expect(original.prepare('SELECT title FROM tasks').get()).toEqual({ title: 'Before migration' });
        original.close();
      }
    }

    expect(backups()).toHaveLength(10);
    const titles = backups().map(name => {
      const backup = openDatabase(join(dir, 'backups', name));
      return (backup.prepare('SELECT title FROM tasks').get() as { title: string }).title;
    });
    expect(titles.sort()).toEqual(Array.from({ length: 10 }, (_, i) => `Snapshot ${i + 3}`).sort());
    expect(existsSync(unrelated)).toBe(true);
  });
});

describe('Store', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:');
  });

  it('creates and looks up projects', () => {
    const p = store.addProject('staging', 'Z:/Repos/Staging');
    expect(p.id).toBe(1);
    expect(p.name).toBe('staging');
    expect(store.listProjects()).toHaveLength(1);
    expect(store.getProject(p.id)?.path).toBe('Z:/Repos/Staging');
    expect(store.getProjectByName('staging')?.id).toBe(p.id);
    expect(store.getProjectByName('nope')).toBeUndefined();
  });

  it('creates tasks with defaults', () => {
    const p = store.addProject('staging', 'Z:/x');
    const t = store.createTask({
      project_id: p.id, title: 'Do thing', description: 'details',
      assignee: 'claude', created_by: 'human', status: 'ready',
    });
    expect(t.bounce_count).toBe(0);
    expect(t.status).toBe('ready');
    expect(t.created_at).toBeTruthy();
    expect(t.updated_at).toBeTruthy();
  });

  it('filters task lists', () => {
    const p1 = store.addProject('a', '/a');
    const p2 = store.addProject('b', '/b');
    store.createTask({ project_id: p1.id, title: 't1', description: '', assignee: 'claude', created_by: 'human', status: 'ready' });
    store.createTask({ project_id: p1.id, title: 't2', description: '', assignee: 'codex', created_by: 'human', status: 'done' });
    store.createTask({ project_id: p2.id, title: 't3', description: '', assignee: 'claude', created_by: 'codex', status: 'ready' });
    expect(store.listTasks()).toHaveLength(3);
    expect(store.listTasks({ project_id: p1.id })).toHaveLength(2);
    expect(store.listTasks({ status: 'ready' })).toHaveLength(2);
    expect(store.listTasks({ assignee: 'claude' })).toHaveLength(2);
    expect(store.listTasks({ project_id: p2.id, status: 'ready', assignee: 'claude' })).toHaveLength(1);
  });

  it('updates tasks and bumps updated_at', async () => {
    const p = store.addProject('a', '/a');
    const t = store.createTask({ project_id: p.id, title: 't', description: '', assignee: 'human', created_by: 'human', status: 'inbox' });
    await new Promise(r => setTimeout(r, 5));
    const t2 = store.updateTask(t.id, { status: 'ready', assignee: 'codex', bounce_count: 2 });
    expect(t2.status).toBe('ready');
    expect(t2.assignee).toBe('codex');
    expect(t2.bounce_count).toBe(2);
    expect(t2.updated_at >= t.updated_at).toBe(true);
  });

  it('appends and lists comments in order', () => {
    const p = store.addProject('a', '/a');
    const t = store.createTask({ project_id: p.id, title: 't', description: '', assignee: 'claude', created_by: 'human', status: 'ready' });
    store.addComment(t.id, 'human', 'first');
    store.addComment(t.id, 'claude', 'second');
    const comments = store.listComments(t.id);
    expect(comments.map(c => c.body)).toEqual(['first', 'second']);
    expect(comments[1].author).toBe('claude');
  });

  it('tracks run lifecycle', () => {
    const p = store.addProject('a', '/a');
    const t = store.createTask({ project_id: p.id, title: 't', description: '', assignee: 'claude', created_by: 'human', status: 'ready' });
    const r = store.createRun(t.id, 'claude', 'the prompt');
    expect(r.status).toBe('running');
    expect(store.runningRuns()).toHaveLength(1);
    const done = store.finishRun(r.id, {
      status: 'succeeded', output_tail: 'out', input_tokens: 10, output_tokens: 5, cost_estimate: 0.01,
    });
    expect(done.status).toBe('succeeded');
    expect(done.finished_at).toBeTruthy();
    expect(done.input_tokens).toBe(10);
    expect(store.runningRuns()).toHaveLength(0);
    expect(store.listRuns(t.id)).toHaveLength(1);
  });

  it('runsSince filters by start time', () => {
    const p = store.addProject('a', '/a');
    const t = store.createTask({ project_id: p.id, title: 't', description: '', assignee: 'claude', created_by: 'human', status: 'ready' });
    store.createRun(t.id, 'claude', 'p');
    expect(store.runsSince(new Date(Date.now() - 60_000).toISOString())).toHaveLength(1);
    expect(store.runsSince(new Date(Date.now() + 60_000).toISOString())).toHaveLength(0);
  });

  it('settings round-trip with default', () => {
    expect(store.getSetting('paused', '0')).toBe('0');
    store.setSetting('paused', '1');
    expect(store.getSetting('paused', '0')).toBe('1');
  });
});
