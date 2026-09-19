export const AGENT_IDS = ['claude', 'codex', 'nyx', 'gemini', 'deepseek'] as const;
export type Agent = typeof AGENT_IDS[number];
export type Author = Agent | 'human';
export type TaskStatus = 'inbox' | 'ready' | 'in_progress' | 'review' | 'needs_human' | 'done';
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'timeout';

export const TASK_STATUSES: TaskStatus[] = ['inbox', 'ready', 'in_progress', 'review', 'needs_human', 'done'];
export const AGENTS: Agent[] = [...AGENT_IDS];

/** Agents a remote worker PC can run. Mirrors the worker config schema in worker-cli.ts. */
export const REMOTE_AGENTS: readonly Agent[] = ['claude', 'codex'];

export interface Project {
  id: number;
  name: string;
  path: string;
  created_at: string;
}

export interface Task {
  id: number;
  project_id: number;
  title: string;
  description: string;
  status: TaskStatus;
  assignee: Author;
  created_by: Author;
  bounce_count: number;
  /** Null executes on the board host; otherwise a named outbound worker. */
  worker_id?: string | null;
  /** Per-task model override for dispatched runs; null = agent default. */
  model: string | null;
  /** Per-task effort override for dispatched runs; null = agent default. */
  effort: string | null;
  created_at: string;
  updated_at: string;
}

export interface Comment {
  id: number;
  task_id: number;
  author: Author;
  body: string;
  created_at: string;
}

export interface Run {
  id: number;
  task_id: number;
  agent: Agent;
  status: RunStatus;
  prompt: string;
  output_tail: string;
  input_tokens: number;
  output_tokens: number;
  cost_estimate: number;
  started_at: string;
  finished_at: string | null;
}
