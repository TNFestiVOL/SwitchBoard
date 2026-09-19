import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { EventBus, type ChangeEvent } from '../src/events.js';
import { toolHandlers, ToolError, ConflictError } from '../src/tools.js';

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

describe('retryable human mutations', () => {
  let store: Store;
  let bus: EventBus;
  beforeEach(() => {
    store = new Store(':memory:');
    store.addProject('staging', '/staging');
    bus = new EventBus();
  });
  afterEach(() => { vi.restoreAllMocks(); store.close(); });

  const cases = [
    { operation: 'create_task', kind: 'task_created', args: { project: 'staging', title: 'new', assignee: 'human' }, changed: { title: 'different' } },
    { operation: 'add_comment', kind: 'comment_added', args: { id: 1, body: 'hello' }, changed: { body: 'different' } },
    { operation: 'assign_task', kind: 'task_assigned', args: { id: 1, assignee: 'codex' }, changed: { assignee: 'human' } },
    { operation: 'update_status', kind: 'status_changed', args: { id: 1, status: 'ready' }, changed: { status: 'done' } },
  ] as const;

  describe.each(cases)('$operation', ({ operation, kind, args, changed }) => {
    beforeEach(() => {
      if (operation !== 'create_task') store.createTask({
        project_id: 1, title: 'existing', description: '', assignee: 'human', created_by: 'human', status: 'inbox',
      });
    });

    it('replays the original result without a second mutation or change event', () => {
      const h = toolHandlers(store, bus, 'human');
      const change = vi.fn();
      bus.onChange(change);
      const input = { ...args, client_id: 'retry_1' };
      const first = h[operation](input as never);
      expect(change).toHaveBeenCalledTimes(1);
      expect(change).toHaveBeenCalledWith({ kind, taskId: 1 });
      if (operation === 'assign_task' || operation === 'update_status') store.updateTask(1, { status: 'review' });
      const beforeReplay = store.getTask(1);

      expect(h[operation](input as never)).toStrictEqual(first);
      expect(change).toHaveBeenCalledTimes(1);
      expect(store.listTasks()).toHaveLength(1);
      expect(store.listComments(1)).toHaveLength(operation === 'add_comment' ? 1 : 0);
      expect(store.getTask(1)).toStrictEqual(beforeReplay);
    });

    it('rejects reuse of client_id for different arguments', () => {
      const h = toolHandlers(store, bus, 'human');
      h[operation]({ ...args, client_id: 'same' } as never);
      const before = h.get_task({ id: 1 });
      const change = vi.fn();
      bus.onChange(change);
      const retry = () => h[operation]({ ...args, ...changed, client_id: 'same' } as never);
      expect(retry).toThrow(ConflictError);
      expect(retry).toThrow('client_id was already used with a different request');
      expect(h.get_task({ id: 1 })).toStrictEqual(before);
      expect(change).not.toHaveBeenCalled();
    });

    it('rejects invalid client_id before mutating', () => {
      const h = toolHandlers(store, bus, 'human');
      const before = store.listTasks();
      const change = vi.fn();
      bus.onChange(change);
      for (const client_id of ['', 'a'.repeat(129), 'with space', 'slash/id', 'é', 42, null, {}, []]) {
        expect(() => h[operation]({ ...args, client_id } as never)).toThrow(ToolError);
      }
      expect(store.listTasks()).toEqual(before);
      expect(store.listComments(1)).toHaveLength(0);
      expect(change).not.toHaveBeenCalled();
    });

    it('commits the operation before notifying synchronous change listeners', () => {
      const h = toolHandlers(store, bus, 'human');
      const input = { ...args, client_id: 'committed' };
      const change = vi.fn(() => {
        expect(store['db'].inTransaction).toBe(false);
        const saved = store.getOperation('human', 'committed');
        expect(saved?.operation).toBe(operation);
        expect(h[operation](input as never)).toEqual(JSON.parse(saved!.result));
      });
      bus.onChange(change);
      h[operation](input as never);
      expect(change).toHaveBeenCalledTimes(1);
    });

    it('rolls back the mutation when recording the operation fails', () => {
      const h = toolHandlers(store, bus, 'human');
      const before = store.listTasks();
      const change = vi.fn();
      bus.onChange(change);
      vi.spyOn(store, 'recordOperation').mockImplementation(() => { throw new Error('storage failed'); });
      expect(() => h[operation]({ ...args, client_id: 'rollback' } as never)).toThrow('storage failed');
      expect(store.listTasks()).toEqual(before);
      expect(store.listComments(1)).toHaveLength(0);
      expect(store.getOperation('human', 'rollback')).toBeUndefined();
      expect(change).not.toHaveBeenCalled();
    });
  });

  it('preserves repeated comments when client_id is omitted', () => {
    const h = toolHandlers(store, bus, 'human');
    const task = h.create_task({ project: 'staging', title: 't', assignee: 'human' });
    h.add_comment({ id: task.id, body: 'twice' });
    h.add_comment({ id: task.id, body: 'twice' });
    expect(store.listComments(task.id)).toHaveLength(2);
  });

  it('scopes client_id to the connection actor', () => {
    const args = { project: 'staging', title: 't', assignee: 'human' as const, client_id: 'shared' };
    toolHandlers(store, bus, 'human').create_task(args);
    toolHandlers(store, bus, 'codex').create_task(args);
    expect(store.listTasks()).toHaveLength(2);
  });

  it('hashes recursively sorted arguments without client_id and preserves array order', () => {
    const h = toolHandlers(store, bus, 'human');
    const metadata = { z: 1, a: [{ z: 2, a: 3 }, 4] };
    const args = { title: 't', project: 'staging', assignee: 'human' as const, metadata, client_id: 'a'.repeat(128) };
    const first = h.create_task(args);
    const reordered = { client_id: args.client_id, metadata: { a: [{ a: 3, z: 2 }, 4], z: 1 }, assignee: 'human' as const, project: 'staging', title: 't' };
    expect(h.create_task(reordered)).toEqual(first);
    const canonical = '{"assignee":"human","metadata":{"a":[{"a":3,"z":2},4],"z":1},"project":"staging","title":"t"}';
    expect(store.getOperation('human', args.client_id)?.body_hash).toBe(createHash('sha256').update(canonical).digest('hex'));
    expect(() => h.create_task({ ...args, metadata: { ...metadata, a: [4, { z: 2, a: 3 }] } } as typeof args)).toThrow(ConflictError);
    expect(store.listTasks()).toHaveLength(1);
  });
});

describe('status compare-and-swap', () => {
  let store: Store;
  let bus: EventBus;
  beforeEach(() => {
    store = new Store(':memory:');
    store.addProject('staging', '/staging');
    store.createTask({ project_id: 1, title: 't', description: '', assignee: 'human', created_by: 'human', status: 'in_progress' });
    bus = new EventBus();
  });
  afterEach(() => store.close());

  it('updates status when expected_status matches', () => {
    const h = toolHandlers(store, bus, 'human');
    expect(h.update_status({ id: 1, status: 'done', expected_status: 'in_progress' }).status).toBe('done');
    expect(store.getTask(1)?.status).toBe('done');
  });

  it.each([undefined, 'stale'])('rejects a stale expected_status without changing the task or emitting an event (client_id=%s)', client_id => {
    const h = toolHandlers(store, bus, 'human');
    store.updateTask(1, { status: 'needs_human' });
    const before = store.getTask(1);
    const change = vi.fn();
    bus.onChange(change);
    const update = () => h.update_status({ id: 1, status: 'done', expected_status: 'in_progress', client_id });
    expect(update).toThrow(ConflictError);
    expect(update).toThrow('task is now needs_human, not in_progress; reload and try again');
    expect(store.getTask(1)).toEqual(before);
    expect(change).not.toHaveBeenCalled();
    if (client_id) {
      expect(store.getOperation('human', client_id)).toBeUndefined();
      expect(h.update_status({ id: 1, status: 'done', expected_status: 'needs_human', client_id }).status).toBe('done');
    }
  });

  it('keeps unconditional status updates when expected_status is omitted', () => {
    const h = toolHandlers(store, bus, 'human');
    store.updateTask(1, { status: 'needs_human' });
    expect(h.update_status({ id: 1, status: 'done' }).status).toBe('done');
  });

  it('rejects invalid expected_status values', () => {
    const h = toolHandlers(store, bus, 'human');
    for (const expected_status of ['bogus', '', null, 42]) {
      expect(() => h.update_status({ id: 1, status: 'done', expected_status: expected_status as never })).toThrow(ToolError);
    }
    expect(store.getTask(1)?.status).toBe('in_progress');
  });

  it('replays a successful status comparison before checking the current status', () => {
    const h = toolHandlers(store, bus, 'human');
    const args = { id: 1, status: 'ready' as const, expected_status: 'in_progress' as const, client_id: 'cas_retry' };
    const first = h.update_status(args);
    store.updateTask(1, { status: 'review' });
    expect(h.update_status(args)).toEqual(first);
    expect(store.getTask(1)?.status).toBe('review');
    expect(() => h.update_status({ ...args, expected_status: 'review' })).toThrow('client_id was already used with a different request');
  });
});
