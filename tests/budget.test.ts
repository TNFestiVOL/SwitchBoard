import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WINDOW_MS, windowUsage, budgetLevel } from '../src/budget.js';
import { scanClaudeTranscripts } from '../src/claude-usage.js';

const now = new Date('2026-08-28T12:00:00Z');
const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();

const run = (agent: 'claude' | 'codex', input: number, output: number, msAgo: number) => ({
  agent, input_tokens: input, output_tokens: output, started_at: iso(msAgo),
});

describe('windowUsage', () => {
  it('sums input+output for the agent inside the window only', () => {
    const runs = [
      run('claude', 100, 50, 60_000),            // in window
      run('claude', 10, 5, WINDOW_MS + 60_000),  // too old
      run('codex', 999, 999, 60_000),            // other agent
    ];
    expect(windowUsage(runs, 'claude', now)).toBe(150);
    expect(windowUsage(runs, 'codex', now)).toBe(1998);
  });
});

describe('budgetLevel', () => {
  it('respects soft and hard lines, 0 disables', () => {
    expect(budgetLevel(50, 100, 200)).toBe('ok');
    expect(budgetLevel(100, 100, 200)).toBe('soft');
    expect(budgetLevel(250, 100, 200)).toBe('hard');
    expect(budgetLevel(1_000_000, 0, 0)).toBe('ok');
    expect(budgetLevel(150, 0, 100)).toBe('hard');
    expect(budgetLevel(150, 100, 0)).toBe('soft');
  });
});

describe('scanClaudeTranscripts', () => {
  it('sums in-window usage entries, ignores junk, 0 on missing dir', () => {
    const base = mkdtempSync(join(tmpdir(), 'sb-usage-'));
    const projDir = join(base, 'proj-a');
    mkdirSync(projDir);
    const realNow = new Date();
    const inWindow = new Date(realNow.getTime() - 60 * 60_000).toISOString();
    const outWindow = new Date(realNow.getTime() - WINDOW_MS - 60 * 60_000).toISOString();
    const lines = [
      JSON.stringify({ timestamp: inWindow, message: { usage: { input_tokens: 100, output_tokens: 50 } } }),
      JSON.stringify({ timestamp: outWindow, message: { usage: { input_tokens: 500, output_tokens: 500 } } }),
      'not json at all {',
      JSON.stringify({ timestamp: inWindow, message: { role: 'user' } }), // no usage
    ].join('\n');
    writeFileSync(join(projDir, 'session.jsonl'), lines);
    expect(scanClaudeTranscripts(base, realNow)).toBe(150);
    expect(scanClaudeTranscripts(join(base, 'does-not-exist'), realNow)).toBe(0);
  });
});
