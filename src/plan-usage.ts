import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AGENTS, type Agent } from './types.js';

const execFileP = promisify(execFile);

/**
 * True subscription-plan usage, pulled from the same sources the CLIs' own
 * /usage and /status screens use:
 *  - Claude: the OAuth usage endpoint, authorized with the LOCAL token from
 *    ~/.claude/.credentials.json. The token is only ever sent to Anthropic.
 *  - Codex: `rate_limits` events that codex writes into its session logs
 *    (~/.codex/sessions/**.jsonl) on every run — zero-cost to read.
 *  - Gemini (agy / Antigravity CLI): `agy -p "/usage" --output-format json` —
 *    a local slash-command expansion (no model call, no cost) whose JSON
 *    carries per-group quota buckets with remaining_fraction and reset_time.
 * Everything degrades to null on any failure; callers treat null as "unknown".
 */

export interface PlanWindow {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}

export interface PlanUsage {
  windows: PlanWindow[];
  fetchedAt: string;
}

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

const CLAUDE_LABELS: Record<string, string> = {
  five_hour: 'session',
  seven_day: 'week',
  seven_day_opus: 'week (opus)',
  seven_day_sonnet: 'week (sonnet)',
  seven_day_oauth_apps: 'week (apps)',
};

const toIso = (v: unknown): string | null => {
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
};

export async function fetchClaudePlanUsage(
  credentialsPath: string,
  fetchFn: typeof fetch = fetch,
): Promise<PlanUsage | null> {
  try {
    const raw = JSON.parse(readFileSync(credentialsPath, 'utf8'));
    const token: unknown = raw?.claudeAiOauth?.accessToken ?? raw?.accessToken;
    if (typeof token !== 'string' || !token) return null;
    const res = await fetchFn(CLAUDE_USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        accept: 'application/json',
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const windows: PlanWindow[] = [];
    for (const [key, val] of Object.entries(data)) {
      if (val && typeof val === 'object' && typeof (val as { utilization?: unknown }).utilization === 'number') {
        const w = val as { utilization: number; resets_at?: unknown };
        windows.push({ label: CLAUDE_LABELS[key] ?? key, usedPercent: w.utilization, resetsAt: toIso(w.resets_at) });
      }
    }
    return windows.length ? { windows, fetchedAt: new Date().toISOString() } : null;
  } catch {
    return null;
  }
}

const findRateLimits = (obj: unknown, depth = 0): Record<string, any> | null => {
  if (!obj || typeof obj !== 'object' || depth > 4) return null;
  const o = obj as Record<string, unknown>;
  if (o.rate_limits && typeof o.rate_limits === 'object') return o.rate_limits as Record<string, any>;
  for (const v of Object.values(o)) {
    const found = findRateLimits(v, depth + 1);
    if (found) return found;
  }
  return null;
};

const windowLabel = (minutes: unknown): string => {
  if (minutes === 300) return 'session';
  if (minutes === 10080) return 'week';
  return typeof minutes === 'number' ? `${Math.round(minutes / 60)}h` : 'window';
};

const newestJsonl = (dir: string): string | null => {
  let best: { path: string; mtime: number } | null = null;
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.jsonl')) {
        try {
          const mtime = statSync(full).mtimeMs;
          if (!best || mtime > best.mtime) best = { path: full, mtime };
        } catch { /* skip */ }
      }
    }
  };
  walk(dir);
  return best ? (best as { path: string }).path : null;
};

export function latestCodexRateLimits(sessionsDir: string): PlanUsage | null {
  try {
    const file = newestJsonl(sessionsDir);
    if (!file) return null;
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('rate_limits')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const rl = findRateLimits(parsed);
      if (!rl) continue;
      const windows: PlanWindow[] = [];
      for (const slot of [rl.primary, rl.secondary]) {
        if (slot && typeof slot.used_percent === 'number') {
          windows.push({
            label: windowLabel(slot.window_minutes),
            usedPercent: slot.used_percent,
            resetsAt: toIso(slot.resets_at),
          });
        }
      }
      if (windows.length) return { windows, fetchedAt: new Date().toISOString() };
    }
    return null;
  } catch {
    return null;
  }
}

export interface PlanUsageTrackerOpts {
  claudeCredentialsPath: string;
  codexSessionsDir: string;
  /** agy (Antigravity CLI) command used to read Gemini plan usage; empty disables the source. */
  agyCmd?: string;
  fetchFn?: typeof fetch;
}

/** Parse `agy -p "/usage" --output-format json` into plan windows for the Gemini model group.
 *  Buckets report quota REMAINING as a 0..1 fraction; the meter wants percent USED. */
export function parseAgyUsage(payload: unknown): PlanUsage | null {
  const groups = (payload as { command?: { data?: { groups?: unknown } } })?.command?.data?.groups;
  if (!Array.isArray(groups)) return null;
  const gemini = groups.find(g => /gemini/i.test(String((g as { name?: unknown })?.name ?? ''))) as
    | { buckets?: { window?: unknown; remaining_fraction?: unknown; reset_time?: unknown }[] }
    | undefined;
  if (!gemini || !Array.isArray(gemini.buckets)) return null;
  const labels: Record<string, string> = { weekly: 'week', '5h': '5h' };
  const windows: PlanWindow[] = [];
  for (const bucket of gemini.buckets) {
    if (typeof bucket?.remaining_fraction !== 'number') continue;
    const label = labels[String(bucket.window ?? '')] ?? String(bucket.window ?? 'window');
    windows.push({
      label,
      usedPercent: Math.max(0, Math.min(100, (1 - bucket.remaining_fraction) * 100)),
      resetsAt: toIso(bucket.reset_time),
    });
  }
  return windows.length ? { windows, fetchedAt: new Date().toISOString() } : null;
}

export async function fetchAgyPlanUsage(agyCmd: string): Promise<PlanUsage | null> {
  try {
    const { stdout } = await execFileP(agyCmd, ['-p', '/usage', '--output-format', 'json'], {
      timeout: 30_000,
      windowsHide: true,
    });
    return parseAgyUsage(JSON.parse(stdout));
  } catch {
    return null;
  }
}

export class PlanUsageTracker {
  private cache: Record<Agent, PlanUsage | null> = Object.fromEntries(
    AGENTS.map(a => [a, null]),
  ) as Record<Agent, PlanUsage | null>;

  constructor(private opts: PlanUsageTrackerOpts) {}

  async refresh(): Promise<void> {
    this.cache.claude = await fetchClaudePlanUsage(this.opts.claudeCredentialsPath, this.opts.fetchFn);
    this.cache.codex = latestCodexRateLimits(this.opts.codexSessionsDir);
    this.cache.gemini = this.opts.agyCmd ? await fetchAgyPlanUsage(this.opts.agyCmd) : null;
  }

  get(agent: Agent): PlanUsage | null {
    return this.cache[agent];
  }

  /** Highest used_percent across the agent's windows; 0 when unknown. */
  maxUsedPercent(agent: Agent): number {
    const usage = this.cache[agent];
    if (!usage) return 0;
    return Math.max(0, ...usage.windows.map(w => w.usedPercent));
  }
}
