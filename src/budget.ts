import type { Agent } from './types.js';

export const WINDOW_MS = 5 * 60 * 60 * 1000;

export type BudgetLevel = 'ok' | 'soft' | 'hard';

export interface UsageRun {
  agent: Agent;
  input_tokens: number;
  output_tokens: number;
  started_at: string;
}

/** Total tokens (input + output) used by `agent` in runs started inside the rolling window. */
export function windowUsage(runs: UsageRun[], agent: Agent, now: Date): number {
  const cutoff = now.getTime() - WINDOW_MS;
  let total = 0;
  for (const r of runs) {
    if (r.agent !== agent) continue;
    const started = Date.parse(r.started_at);
    if (Number.isNaN(started) || started < cutoff) continue;
    total += (r.input_tokens || 0) + (r.output_tokens || 0);
  }
  return total;
}

/** A line of 0 means "disabled". Hard wins over soft. */
export function budgetLevel(used: number, soft: number, hard: number): BudgetLevel {
  if (hard > 0 && used >= hard) return 'hard';
  if (soft > 0 && used >= soft) return 'soft';
  return 'ok';
}
