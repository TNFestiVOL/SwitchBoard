import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkerTokens, saveTuning, type Config } from '../src/config.js';

describe('saveTuning', () => {
  let dir: string;
  let configPath: string;
  const tuning: Config['tuning'] = { claude: {}, codex: { model: 'new', effort: 'high' }, nyx: {}, gemini: {}, deepseek: {} };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sb-tuning-'));
    configPath = join(dir, 'switchboard.config.json');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('leaves invalid JSON byte-for-byte intact without creating a temporary file', () => {
    const original = Buffer.from('{ "machines": [\r\n  invalid JSON\r\n');
    writeFileSync(configPath, original);

    expect(() => saveTuning(configPath, tuning)).toThrow('switchboard.config.json is not valid JSON; tuning not saved');

    expect(readFileSync(configPath)).toEqual(original);
    expect(existsSync(configPath + '.tmp')).toBe(false);
  });

  it('preserves every other configuration key when saving tuning', () => {
    const original = {
      machines: [{ workerId: 'amber', name: 'Worker', ip: '192.0.2.10' }],
      remote: { port: 4681, tokenEnv: { amber: 'SB_AMBER' } },
      parallelWorktrees: true,
      agentConcurrency: { codex: 2 },
      deepseekCmd: 'custom-command',
      agents: { nyx: { url: 'http://127.0.0.1:9000' } },
      tuning: { codex: { model: 'old' } },
    };
    writeFileSync(configPath, JSON.stringify(original));

    saveTuning(configPath, tuning);

    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ ...original, tuning });
    expect(readFileSync(configPath, 'utf8')).toBe(JSON.stringify({ ...original, tuning }, null, 2) + '\n');
    expect(existsSync(configPath + '.tmp')).toBe(false);
  });

  it('creates a missing configuration file containing tuning', () => {
    saveTuning(configPath, tuning);

    expect(readFileSync(configPath, 'utf8')).toBe(JSON.stringify({ tuning }, null, 2) + '\n');
    expect(existsSync(configPath + '.tmp')).toBe(false);
  });

  it('propagates read errors other than a missing file without writing', () => {
    mkdirSync(configPath);

    expect(() => saveTuning(configPath, tuning)).toThrow(/EISDIR/);

    expect(statSync(configPath).isDirectory()).toBe(true);
    expect(existsSync(configPath + '.tmp')).toBe(false);
  });
});

describe('resolveWorkerTokens', () => {
  const tokenEnv = { amber: 'SB_AMBER', aces: 'SB_ACES', short: 'SB_SHORT' };

  it('keeps valid tokens and reports missing or short ones without throwing', () => {
    const { tokens, problems } = resolveWorkerTokens(tokenEnv, { SB_AMBER: 'a'.repeat(32), SB_SHORT: 'tiny' });
    expect(tokens).toEqual({ amber: 'a'.repeat(32) });
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toContain('SB_ACES is not set');
    expect(problems.join('\n')).toContain('SB_SHORT must be at least 32 characters');
  });

  it('configures nothing when no variables are set', () => {
    const { tokens, problems } = resolveWorkerTokens(tokenEnv, {});
    expect(Object.keys(tokens)).toHaveLength(0);
    expect(problems).toHaveLength(3);
  });
});
