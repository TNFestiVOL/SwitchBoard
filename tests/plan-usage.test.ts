import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchClaudePlanUsage, latestCodexRateLimits, parseAgyUsage, PlanUsageTracker } from '../src/plan-usage.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'sb-plan-'));

const credFile = (dir: string): string => {
  const p = join(dir, '.credentials.json');
  writeFileSync(p, JSON.stringify({ claudeAiOauth: { accessToken: 'sk-test-token' } }));
  return p;
};

const okFetch = (body: unknown, ok = true): typeof fetch =>
  (async (_url: unknown, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-test-token');
    return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
  }) as typeof fetch;

describe('fetchClaudePlanUsage', () => {
  it('maps utilization windows from the oauth usage endpoint', async () => {
    const usage = await fetchClaudePlanUsage(credFile(tmp()), okFetch({
      five_hour: { utilization: 24, resets_at: '2026-08-29T06:30:00Z' },
      seven_day: { utilization: 20, resets_at: '2026-08-30T10:00:00Z' },
      seven_day_opus: { utilization: 31, resets_at: '2026-08-30T10:00:00Z' },
      unrelated: 'ignore me',
    }));
    expect(usage).not.toBeNull();
    const byLabel = Object.fromEntries(usage!.windows.map(w => [w.label, w]));
    expect(byLabel['session'].usedPercent).toBe(24);
    expect(byLabel['week'].usedPercent).toBe(20);
    expect(byLabel['week (opus)'].usedPercent).toBe(31);
    expect(byLabel['session'].resetsAt).toBe('2026-08-29T06:30:00.000Z');
  });

  it('returns null on missing file, missing token, or http failure', async () => {
    expect(await fetchClaudePlanUsage(join(tmp(), 'nope.json'), okFetch({}))).toBeNull();
    const dir = tmp();
    const p = join(dir, '.credentials.json');
    writeFileSync(p, JSON.stringify({ claudeAiOauth: {} }));
    expect(await fetchClaudePlanUsage(p, okFetch({}))).toBeNull();
    expect(await fetchClaudePlanUsage(credFile(tmp()), okFetch({}, false))).toBeNull();
  });
});

describe('latestCodexRateLimits', () => {
  it('reads the newest session jsonl and maps primary/secondary windows', () => {
    const dir = tmp();
    const nested = join(dir, '2026', '08', '28');
    mkdirSync(nested, { recursive: true });
    const resets = Math.floor(Date.now() / 1000) + 6 * 24 * 3600;
    writeFileSync(join(nested, 'rollout-old.jsonl'), JSON.stringify({
      payload: { rate_limits: { primary: { used_percent: 50, window_minutes: 10080, resets_at: resets } } },
    }));
    utimesSync(join(nested, 'rollout-old.jsonl'), new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
    const newer = join(dir, '2026', '08', '29');
    mkdirSync(newer, { recursive: true });
    writeFileSync(join(newer, 'rollout-new.jsonl'), [
      'junk not json {',
      JSON.stringify({ payload: { type: 'other' } }),
      JSON.stringify({
        payload: {
          rate_limits: {
            primary: { used_percent: 1.0, window_minutes: 10080, resets_at: resets },
            secondary: { used_percent: 3.5, window_minutes: 300, resets_at: resets },
          },
        },
      }),
    ].join('\n'));
    const usage = latestCodexRateLimits(dir);
    expect(usage).not.toBeNull();
    const byLabel = Object.fromEntries(usage!.windows.map(w => [w.label, w]));
    expect(byLabel['week'].usedPercent).toBe(1.0);
    expect(byLabel['session'].usedPercent).toBe(3.5);
    expect(byLabel['week'].resetsAt).toBe(new Date(resets * 1000).toISOString());
  });

  it('returns null for missing dir or no rate_limits anywhere', () => {
    expect(latestCodexRateLimits(join(tmp(), 'ghost'))).toBeNull();
    const dir = tmp();
    writeFileSync(join(dir, 'a.jsonl'), JSON.stringify({ payload: { type: 'nothing' } }));
    expect(latestCodexRateLimits(dir)).toBeNull();
  });
});

describe('parseAgyUsage', () => {
  const agyPayload = {
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.75, reset_time: '2026-09-14T05:46:00Z' },
              { id: 'gemini-5h', window: '5h', remaining_fraction: 0.5, reset_time: '2026-09-07T10:46:00Z' },
            ],
          },
          {
            name: 'Claude and GPT models',
            buckets: [
              { id: '3p-weekly', window: 'weekly', remaining_fraction: 1, reset_time: '2026-09-14T05:47:01Z' },
            ],
          },
        ],
      },
    },
  };

  it('converts remaining fractions to used percent for the gemini group only', () => {
    const usage = parseAgyUsage(agyPayload);
    expect(usage).not.toBeNull();
    const byLabel = Object.fromEntries(usage!.windows.map(w => [w.label, w]));
    expect(byLabel['week'].usedPercent).toBeCloseTo(25);
    expect(byLabel['5h'].usedPercent).toBeCloseTo(50);
    expect(byLabel['week'].resetsAt).toBe('2026-09-14T05:46:00.000Z');
    expect(usage!.windows).toHaveLength(2); // the Claude/GPT group is ignored
  });

  it('clamps and skips malformed buckets, nulls on junk payloads', () => {
    const weird = structuredClone(agyPayload);
    const buckets = (weird as any).command.data.groups[0].buckets;
    buckets.push({ window: 'weekly', remaining_fraction: -0.2 }); // clamps to 0 used... actually 120 → 100
    buckets.push({ window: 'weekly' }); // no fraction — skipped
    const usage = parseAgyUsage(weird)!;
    expect(usage.windows).toHaveLength(3);
    expect(usage.windows[2].usedPercent).toBe(100);
    expect(parseAgyUsage({})).toBeNull();
    expect(parseAgyUsage({ command: { data: { groups: [] } } })).toBeNull();
    expect(parseAgyUsage('nope')).toBeNull();
  });
});

describe('PlanUsageTracker', () => {
  it('caches per agent and reports max window percent', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 's.jsonl'), JSON.stringify({
      payload: { rate_limits: { primary: { used_percent: 88, window_minutes: 10080, resets_at: 0 } } },
    }));
    const tracker = new PlanUsageTracker({
      claudeCredentialsPath: credFile(tmp()),
      codexSessionsDir: dir,
      fetchFn: okFetch({ five_hour: { utilization: 24 }, seven_day: { utilization: 31 } }),
    });
    expect(tracker.get('claude')).toBeNull(); // nothing before refresh
    expect(tracker.maxUsedPercent('claude')).toBe(0);
    await tracker.refresh();
    expect(tracker.maxUsedPercent('claude')).toBe(31);
    expect(tracker.maxUsedPercent('codex')).toBe(88);
    expect(tracker.get('codex')!.windows[0].label).toBe('week');
    // no agyCmd configured -> gemini stays unknown; deepseek has no true-plan source at all
    expect(tracker.get('gemini')).toBeNull();
    expect(tracker.get('deepseek')).toBeNull();
  });
});
