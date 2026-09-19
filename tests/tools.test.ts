import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../src/store.js';
import { EventBus, type ChangeEvent } from '../src/events.js';
import { toolHandlers, ToolError } from '../src/tools.js';

describe('toolHandlers', () => {
  let store: Store;
  let bus: EventBus;
  let events: ChangeEvent[];

  beforeEach(() => {
    store = new Store(':memory:');
    bus = new EventBus();
    events = [];
    bus.onChange(e => events.push(e));
    store.addProject('staging', 'Z:/Repos/Staging');
  });

  it('create_task assigned to an agent starts ready', () => {
    const t = toolHandlers(store, bus, 'human').create_task({
      project: 'staging', title: 'Build it', description: 'x', assignee: 'codex',
    });
    expect(t.status).toBe('ready');
    expect(t.created_by).toBe('human');
    expect(events.length).toBe(1);
  });

  it('create_task assigned to nyx starts ready', () => {
    const t = toolHandlers(store, bus, 'human').create_task({
      project: 'staging', title: 'Send to Nyx', description: 'x', assignee: 'nyx',
    });
    expect(t.status).toBe('ready');
    expect(t.assignee).toBe('nyx');
  });

  it('rejects unknown or unsupported remote worker assignments when workers are configured', () => {
    const h = toolHandlers(store, bus, 'human', { workers: new Set(['amber']) });
    expect(() => h.create_task({ project: 'staging', title: 'x', assignee: 'codex', worker_id: 'ambr' })).toThrow(/Unknown worker "ambr"/);
    expect(() => h.create_task({ project: 'staging', title: 'x', assignee: 'gemini', worker_id: 'amber' })).toThrow(/claude or codex/);
    const ok = h.create_task({ project: 'staging', title: 'x', assignee: 'codex', worker_id: 'amber' });
    expect(ok.worker_id).toBe('amber');
    expect(() => h.assign_task({ id: ok.id, assignee: 'gemini' })).toThrow(/claude or codex/);
    expect(h.assign_task({ id: ok.id, assignee: 'human' }).status).toBe('needs_human');
  });

  it('accepts any well-formed worker id when no worker list is supplied', () => {
    const t = toolHandlers(store, bus, 'human').create_task({ project: 'staging', title: 'x', assignee: 'codex', worker_id: 'anything' });
    expect(t.worker_id).toBe('anything');
  });

  it('create_task assigned to human starts inbox', () => {
    const t = toolHandlers(store, bus, 'claude').create_task({
      project: 'staging', title: 'Review me', assignee: 'human',
    });
    expect(t.status).toBe('inbox');
    expect(t.created_by).toBe('claude');
  });

  it('create_task stores optional model/effort overrides', () => {
    const h = toolHandlers(store, bus, 'claude');
    const t = h.create_task({ project: 'staging', title: 'hard', assignee: 'codex', model: 'gpt-5.1-codex-max', effort: 'xhigh' });
    expect(t.model).toBe('gpt-5.1-codex-max');
    expect(t.effort).toBe('xhigh');
    const plain = h.create_task({ project: 'staging', title: 'easy', assignee: 'codex' });
    expect(plain.model).toBeNull();
    expect(plain.effort).toBeNull();
  });

  it('create_task with draft parks agent-assigned tasks in inbox, keeping the assignee', () => {
    const h = toolHandlers(store, bus, 'claude');
    const t = h.create_task({ project: 'staging', title: 'planned work', assignee: 'codex', draft: true });
    expect(t.status).toBe('inbox');
    expect(t.assignee).toBe('codex');
  });

  it('create_task records dependencies and rejects missing ones', () => {
    const h = toolHandlers(store, bus, 'claude');
    const a = h.create_task({ project: 'staging', title: 'a', assignee: 'codex' });
    const b = h.create_task({ project: 'staging', title: 'b', assignee: 'claude', depends_on: [a.id] });
    expect(b.depends_on).toEqual([a.id]);
    expect(store.listDependencies(b.id)).toEqual([a.id]);
    expect(store.unmetDependencies(b.id)).toEqual([a.id]);
    store.updateTask(a.id, { status: 'review' });
    expect(store.unmetDependencies(b.id)).toEqual([]);
    expect(() => h.create_task({ project: 'staging', title: 'c', assignee: 'codex', depends_on: [999] })).toThrow(ToolError);
  });

  it('create_task with unknown project throws ToolError', () => {
    expect(() => toolHandlers(store, bus, 'human').create_task({
      project: 'nope', title: 'x', assignee: 'claude',
    })).toThrow(ToolError);
  });

  it('claim_task sets in_progress and assignee to actor', () => {
    const h = toolHandlers(store, bus, 'codex');
    const t = h.create_task({ project: 'staging', title: 'x', assignee: 'claude' });
    const claimed = h.claim_task({ id: t.id });
    expect(claimed.status).toBe('in_progress');
    expect(claimed.assignee).toBe('codex');
  });

  it('assign_task to agent → ready, to human → needs_human', () => {
    const h = toolHandlers(store, bus, 'claude');
    const t = h.create_task({ project: 'staging', title: 'x', assignee: 'claude' });
    expect(h.assign_task({ id: t.id, assignee: 'codex' }).status).toBe('ready');
    expect(h.assign_task({ id: t.id, assignee: 'human' }).status).toBe('needs_human');
  });

  it('add_comment attributes to the connection actor, not args', () => {
    const h = toolHandlers(store, bus, 'codex');
    const t = h.create_task({ project: 'staging', title: 'x', assignee: 'claude' });
    h.add_comment({ id: t.id, body: 'I am definitely claude' });
    expect(store.listComments(t.id)[0].author).toBe('codex');
  });

  it('update_status rejects invalid status', () => {
    const h = toolHandlers(store, bus, 'human');
    const t = h.create_task({ project: 'staging', title: 'x', assignee: 'claude' });
    expect(() => h.update_status({ id: t.id, status: 'bogus' as never })).toThrow(ToolError);
    expect(h.update_status({ id: t.id, status: 'done' }).status).toBe('done');
  });

  it('finish_task posts summary and sets review', () => {
    const h = toolHandlers(store, bus, 'claude');
    const t = h.create_task({ project: 'staging', title: 'x', assignee: 'claude' });
    const finished = h.finish_task({ id: t.id, summary: 'all wired up' });
    expect(finished.status).toBe('review');
    const comments = store.listComments(t.id);
    expect(comments[0].body).toBe('all wired up');
    expect(comments[0].author).toBe('claude');
  });

  it('get_task returns task, comments, and runs', () => {
    const h = toolHandlers(store, bus, 'human');
    const t = h.create_task({ project: 'staging', title: 'x', assignee: 'claude' });
    h.add_comment({ id: t.id, body: 'note' });
    store.createRun(t.id, 'claude', 'p');
    const full = h.get_task({ id: t.id });
    expect(full.task.id).toBe(t.id);
    expect(full.comments).toHaveLength(1);
    expect(full.runs).toHaveLength(1);
    expect(() => h.get_task({ id: 999 })).toThrow(ToolError);
  });

  it('list_tasks filters by project name, status, assignee', () => {
    const h = toolHandlers(store, bus, 'human');
    store.addProject('other', '/o');
    h.create_task({ project: 'staging', title: 'a', assignee: 'claude' });
    h.create_task({ project: 'other', title: 'b', assignee: 'codex' });
    expect(h.list_tasks({})).toHaveLength(2);
    expect(h.list_tasks({ project: 'staging' })).toHaveLength(1);
    expect(h.list_tasks({ assignee: 'codex' })).toHaveLength(1);
    expect(() => h.list_tasks({ project: 'ghost' })).toThrow(ToolError);
  });

  it('every mutation emits a change event', () => {
    const h = toolHandlers(store, bus, 'human');
    const t = h.create_task({ project: 'staging', title: 'x', assignee: 'claude' });
    h.claim_task({ id: t.id });
    h.add_comment({ id: t.id, body: 'c' });
    h.assign_task({ id: t.id, assignee: 'codex' });
    h.update_status({ id: t.id, status: 'ready' });
    h.finish_task({ id: t.id, summary: 's' });
    expect(events.length).toBe(6);
    expect(events.every(e => e.taskId === t.id)).toBe(true);
  });
});
