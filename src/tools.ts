import type { Store } from './store.js';
import type { EventBus } from './events.js';
import { AGENTS, REMOTE_AGENTS, TASK_STATUSES, type Author, type Comment, type Run, type Task, type TaskStatus } from './types.js';

export class ToolError extends Error {}

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

    create_task(args: { project: string; title: string; description?: string; assignee: Author; model?: string; effort?: string; draft?: boolean; depends_on?: number[]; worker_id?: string }): Task & { depends_on: number[] } {
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
      bus.change({ kind: 'task_created', taskId: task.id });
      return { ...task, depends_on: deps };
    },

    claim_task(args: { id: number }): Task {
      mustTask(args.id);
      const task = store.updateTask(args.id, { status: 'in_progress', assignee: actor });
      bus.change({ kind: 'task_claimed', taskId: task.id });
      return task;
    },

    add_comment(args: { id: number; body: string }): Comment {
      mustTask(args.id);
      const comment = store.addComment(args.id, actor, args.body);
      bus.change({ kind: 'comment_added', taskId: args.id });
      return comment;
    },

    assign_task(args: { id: number; assignee: Author }): Task {
      const current = mustTask(args.id);
      const assignee = validAuthor(args.assignee);
      if (current.worker_id) remoteAgentOnly(assignee);
      const status: TaskStatus = assignee === 'human' ? 'needs_human' : 'ready';
      const task = store.updateTask(args.id, { assignee, status });
      bus.change({ kind: 'task_assigned', taskId: task.id });
      return task;
    },

    update_status(args: { id: number; status: TaskStatus }): Task {
      mustTask(args.id);
      if (!TASK_STATUSES.includes(args.status)) throw new ToolError(`Invalid status "${args.status}". Valid: ${TASK_STATUSES.join(', ')}`);
      const task = store.updateTask(args.id, { status: args.status });
      bus.change({ kind: 'status_changed', taskId: task.id });
      return task;
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
