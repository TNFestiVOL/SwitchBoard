import { createHash } from 'node:crypto';
import type { Store } from './store.js';
import type { ChangeEvent, EventBus } from './events.js';
import { AGENTS, REMOTE_AGENTS, TASK_STATUSES, type Author, type Comment, type Run, type Task, type TaskStatus } from './types.js';

export class ToolError extends Error {}
export class ConflictError extends ToolError {}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const object = item as Record<string, unknown>;
      return Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]]));
    }
    return item;
  });
}

export interface TaskDetail {
  task: Task;
  comments: Comment[];
  runs: Run[];
}

export interface ToolOptions {
  /** Worker ids with a configured credential. When given, any other worker_id is rejected. */
  workers?: ReadonlySet<string>;
}

export function toolHandlers(store: Store, bus: EventBus, actor: Author, options: ToolOptions = {}) {
  const mustTask = (id: number): Task => {
    const t = store.getTask(id);
    if (!t) throw new ToolError(`No task with id ${id}`);
    return t;
  };

  const mustProject = (name: string) => {
    const p = store.getProjectByName(name);
    if (!p) throw new ToolError(`No project named "${name}". Use list_tasks first or ask the human to register it.`);
    return p;
  };

  const validAuthor = (a: string): Author => {
    if (a !== 'human' && !(AGENTS as string[]).includes(a)) throw new ToolError(`Invalid assignee "${a}"`);
    return a as Author;
  };

  const remoteAgentOnly = (assignee: Author): void => {
    if (assignee !== 'human' && !(REMOTE_AGENTS as readonly string[]).includes(assignee)) {
      throw new ToolError(`Remote workers can only run ${REMOTE_AGENTS.join(' or ')}; "${assignee}" must run on the board host (omit worker_id).`);
    }
  };

  const mutate = <T>(operation: string, args: { client_id?: string }, execute: () => { result: T; event: ChangeEvent }): T => {
    const { client_id, ...body } = args;
    let event: ChangeEvent | undefined;
    const firstExecution = (): T => {
      const mutation = execute();
      event = mutation.event;
      return mutation.result;
    };
    let result: T;
    if (client_id === undefined) {
      result = firstExecution();
    } else {
      if (typeof client_id !== 'string' || client_id.length < 1 || client_id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(client_id)) {
        throw new ToolError('Invalid client_id: use 1-128 letters, digits, underscores or hyphens');
      }
      const body_hash = createHash('sha256').update(canonicalJson(body)).digest('hex');
      result = store.transaction(() => {
        const existing = store.getOperation(actor, client_id);
        if (existing) {
          if (existing.body_hash !== body_hash) throw new ConflictError('client_id was already used with a different request');
          return JSON.parse(existing.result) as T;
        }
        const created = firstExecution();
        store.recordOperation({ actor, client_id, operation, body_hash, result: JSON.stringify(created) });
        return created;
      });
    }
    if (event) bus.change(event);
    return result;
  };

  return {
    list_tasks(args: { project?: string; status?: TaskStatus; assignee?: Author }): Task[] {
      const filter: { project_id?: number; status?: TaskStatus; assignee?: Author } = {};
      if (args.project) filter.project_id = mustProject(args.project).id;
      if (args.status) filter.status = args.status;
      if (args.assignee) filter.assignee = args.assignee;
      return store.listTasks(filter);
    },

    get_task(args: { id: number }): TaskDetail {
      const task = mustTask(args.id);
      return { task, comments: store.listComments(task.id), runs: store.listRuns(task.id) };
    },

    create_task(args: { project: string; title: string; description?: string; assignee: Author; model?: string; effort?: string; draft?: boolean; depends_on?: number[]; worker_id?: string; client_id?: string }): Task & { depends_on: number[] } {
      return mutate('create_task', args, () => {
        const project = mustProject(args.project);
        const assignee = validAuthor(args.assignee);
        const worker = args.worker_id?.trim() || null;
        if (worker && !/^[a-zA-Z0-9_-]{1,64}$/.test(worker)) throw new ToolError('Invalid worker id');
        if (worker && options.workers && !options.workers.has(worker)) {
          const known = [...options.workers].sort();
          throw new ToolError(`Unknown worker "${worker}". ${known.length ? `Configured workers: ${known.join(', ')}` : 'No remote workers are configured'}; omit worker_id to run on the board host.`);
        }
        if (worker) remoteAgentOnly(assignee);
        // draft: park in inbox (no dispatch) but keep the intended assignee for later release
        const status: TaskStatus = !args.draft && (AGENTS as string[]).includes(assignee) ? 'ready' : 'inbox';
        const deps = [...new Set(args.depends_on ?? [])];
        for (const depId of deps) {
          if (!store.getTask(depId)) throw new ToolError(`depends_on refers to missing task ${depId}`);
        }
        const task = store.createTaskWithDependencies({
          project_id: project.id,
          title: args.title,
          description: args.description ?? '',
          assignee,
          created_by: actor,
          status,
          model: args.model?.trim() || null,
          effort: args.effort?.trim() || null,
          worker_id: worker,
        }, deps);
        return { result: { ...task, depends_on: deps }, event: { kind: 'task_created', taskId: task.id } };
      });
    },

    claim_task(args: { id: number }): Task {
      mustTask(args.id);
      const task = store.updateTask(args.id, { status: 'in_progress', assignee: actor });
      bus.change({ kind: 'task_claimed', taskId: task.id });
      return task;
    },

    add_comment(args: { id: number; body: string; client_id?: string }): Comment {
      return mutate('add_comment', args, () => {
        mustTask(args.id);
        const comment = store.addComment(args.id, actor, args.body);
        return { result: comment, event: { kind: 'comment_added', taskId: args.id } };
      });
    },

    assign_task(args: { id: number; assignee: Author; client_id?: string }): Task {
      return mutate('assign_task', args, () => {
        const current = mustTask(args.id);
        const assignee = validAuthor(args.assignee);
        if (current.worker_id) remoteAgentOnly(assignee);
        const status: TaskStatus = assignee === 'human' ? 'needs_human' : 'ready';
        const task = store.updateTask(args.id, { assignee, status });
        return { result: task, event: { kind: 'task_assigned', taskId: task.id } };
      });
    },

    update_status(args: { id: number; status: TaskStatus; client_id?: string; expected_status?: TaskStatus }): Task {
      return mutate('update_status', args, () => {
        const current = mustTask(args.id);
        if (!TASK_STATUSES.includes(args.status)) throw new ToolError(`Invalid status "${args.status}". Valid: ${TASK_STATUSES.join(', ')}`);
        if (args.expected_status !== undefined) {
          if (!TASK_STATUSES.includes(args.expected_status)) throw new ToolError(`Invalid expected_status "${args.expected_status}". Valid: ${TASK_STATUSES.join(', ')}`);
          if (current.status !== args.expected_status) throw new ConflictError(`task is now ${current.status}, not ${args.expected_status}; reload and try again`);
        }
        const task = store.updateTask(args.id, { status: args.status });
        return { result: task, event: { kind: 'status_changed', taskId: task.id } };
      });
    },

    finish_task(args: { id: number; summary: string }): Task {
      mustTask(args.id);
      store.addComment(args.id, actor, args.summary);
      const task = store.updateTask(args.id, { status: 'review' });
      bus.change({ kind: 'task_finished', taskId: task.id });
      return task;
    },
  };
}

export type ToolHandlers = ReturnType<typeof toolHandlers>;
