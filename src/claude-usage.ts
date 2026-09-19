import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { WINDOW_MS } from './budget.js';

/**
 * Estimate Claude tokens used in the rolling window by scanning local Claude Code
 * transcript JSONL files (ccusage-style). This captures interactive usage that
 * Switchboard's own runs table can't see. Best-effort: any I/O or parse failure
 * contributes 0 rather than throwing.
 */
export function scanClaudeTranscripts(baseDir: string, now: Date = new Date()): number {
  const cutoff = now.getTime() - WINDOW_MS;
  let total = 0;

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.jsonl')) continue;
      try {
        if (statSync(full).mtimeMs < cutoff) continue; // file untouched since window start
        for (const line of readFileSync(full, 'utf8').split('\n')) {
          try {
            const obj = JSON.parse(line);
            const ts = Date.parse(obj?.timestamp);
            const usage = obj?.message?.usage;
            if (Number.isNaN(ts) || ts < cutoff || !usage) continue;
            total += (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0);
          } catch {
            // malformed line — skip
          }
        }
      } catch {
        // unreadable file — skip
      }
    }
  };

  walk(baseDir);
  return total;
}
