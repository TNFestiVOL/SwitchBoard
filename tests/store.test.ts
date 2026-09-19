import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../src/store.js';

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
