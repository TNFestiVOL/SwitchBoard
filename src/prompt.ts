import { AGENTS, type Agent, type Comment, type Project, type Task } from './types.js';

export interface BuildPromptInput {
  task: Task;
  project: Project;
  comments: Comment[];
  agent: Agent;
  maxComments?: number;
  /** Set for runs executing on a remote worker PC: no hand-offs, files stay on that PC. */
  remote?: { workerId: string };
}

/** Agents a dispatched run may hand the task to — every other agent on the board. */
export const handoffTargets = (agent: Agent): Agent[] => AGENTS.filter(a => a !== agent);

/** The prompt handed to a headless agent run. Pure function, no I/O. */
export function buildPrompt({ task, project, comments, agent, maxComments = 10, remote }: BuildPromptInput): string {
  const others = handoffTargets(agent).map(a => `"${a}"`).join(', ');
  const recent = comments.slice(-maxComments);
  const thread = recent.length
    ? recent.map(c => `[${c.author}] ${c.body}`).join('\n')
    : '(no comments yet)';
  const where = remote ? ` on remote worker "${remote.workerId}"` : '';
  const handoff = remote
    ? `- This connection is scoped to task ${task.id} on this PC: do not create or reassign other tasks. Files you change stay on this PC; other machines do not share its filesystem.`
    : `- To hand the task to another agent (${others}) for review or follow-up work, call assign_task (id: ${task.id}, assignee: "<their name>") after leaving a comment explaining what you need from them.`;
  const closing = remote ? 'finish_task or update_status' : 'finish_task, assign_task, or update_status';

  return `You are "${agent}", one of several coding agents collaborating through the Switchboard task board.
You have been dispatched to work on task ${task.id} in project "${project.name}"${where}.
Your working directory is: ${project.path}

## Task ${task.id}: ${task.title}

${task.description || '(no description)'}

## Recent thread

${thread}

## How to respond

Do the work in the current working directory. Then report through the "switchboard" MCP tools (they act on this same task board):

- Post progress or findings with add_comment (id: ${task.id}).
- When the task is complete, call finish_task (id: ${task.id}) with a concise summary of what you did.
${handoff}
- If you are blocked or need a human decision, call add_comment with your question, then update_status (id: ${task.id}, status: "needs_human").

Always end by calling exactly one of ${closing} so the board reflects reality.`;
}

/**
 * The briefing appended to a planning task's description by POST /api/plan.
 * The planner decomposes the goal into board tasks; it does not implement anything.
 */
export function plannerBrief(projectName: string, planner: Agent, draft = false): string {
  const workers = AGENTS.filter(a => a !== planner).map(a => `"${a}"`).join(', ');
  const draftNote = draft ? `
   DRAFT MODE: pass draft: true on EVERY create_task call. Tasks then park in the inbox
   (keeping their assignee) instead of dispatching; the human reviews the plan and releases
   them. Do not skip this flag on any task.` : '';
  return `---
PLANNER BRIEF — you are the planning agent. Do NOT implement the goal yourself.

1. Explore the project directory enough to plan well (structure, stack, what exists already).
2. Break the goal above into small, independent tasks. Each task's description must be
   self-contained — the worker who picks it up sees ONLY that task and its thread, not this plan.
   Include acceptance criteria ("done when ...").
3. Create each task on this board with the create_task tool (project: "${projectName}"${draft ? ', draft: true' : ''}).
   Distribute them between the other agents (${workers}) based on the work's nature — balance the load.
   Optionally set "model" and "effort" per task to give hard tasks a bigger brain and easy
   tasks a cheaper one.${draftNote}
4. Ordering: declare it explicitly. create_task returns the created task's id — pass earlier
   ids as depends_on on later tasks. A task dispatches only after all its dependencies reach
   review/done, and tasks with no path between them MAY RUN IN PARALLEL (one per agent), so
   declare true dependencies only — don't chain everything linearly out of habit. If something
   must wait on outside input, assign it to "human" so it parks in the inbox.
5. When all tasks are created, call finish_task on THIS task with a short overview of the plan:
   how many tasks, who got what, and the intended sequence.`;
}
