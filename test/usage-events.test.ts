import { describe, expect, it } from 'vite-plus/test';

import { usageEventFromPayload } from '../src/usage-events.js';

const NOW = Date.now();

describe('usageEventFromPayload', () => {
  it('extracts a usage event from a dsh plugin payload', () => {
    const result = usageEventFromPayload(
      'dsh',
      {
        session_id: 's1',
        cwd: '/repo',
        model: 'deepseek-v4-pro',
        usage: { inputTokens: 900, outputTokens: 100, cacheReadTokens: 2000, cacheWriteTokens: 0 }
      },
      NOW
    );
    expect(result).toEqual({
      source: 'dsh',
      model: 'deepseek-v4-pro',
      timestamp: NOW,
      inputTokens: 900,
      outputTokens: 100,
      cacheWriteTokens: 0,
      cacheReadTokens: 2000
    });
  });

  it('defaults a missing model to unknown', () => {
    const result = usageEventFromPayload('dsh', { usage: { inputTokens: 10, outputTokens: 5 } }, NOW);
    expect(result?.model).toBe('unknown');
  });

  it('returns null when the payload carries no usage', () => {
    expect(usageEventFromPayload('dsh', { session_id: 's1' }, NOW)).toBeNull();
  });

  it('returns null when all buckets are zero', () => {
    expect(usageEventFromPayload('dsh', { usage: { inputTokens: 0, outputTokens: 0 } }, NOW)).toBeNull();
  });

  it('coerces non-finite and negative values to zero', () => {
    const result = usageEventFromPayload(
      'dsh',
      { usage: { inputTokens: Number.NaN, outputTokens: -5, cacheReadTokens: 2000 } },
      NOW
    );
    expect(result).toMatchObject({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 2000 });
  });
});
