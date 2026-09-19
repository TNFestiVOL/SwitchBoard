import { describe, it, expect } from 'vitest';
import { resolveWorkerTokens } from '../src/config.js';

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
