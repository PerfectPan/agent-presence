import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendUsageEvent, getUsageEventsPath, readUsageEvents, usageEventFromPayload, type UsageEvent } from '../src/usage-events.js';

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

let dir: string;
let savedEventsFile: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-presence-usage-events-'));
  savedEventsFile = process.env.AGENT_PRESENCE_USAGE_EVENTS_FILE;
  process.env.AGENT_PRESENCE_USAGE_EVENTS_FILE = join(dir, 'usage-events.log');
});

afterEach(async () => {
  if (savedEventsFile === undefined) {
    delete process.env.AGENT_PRESENCE_USAGE_EVENTS_FILE;
  } else {
    process.env.AGENT_PRESENCE_USAGE_EVENTS_FILE = savedEventsFile;
  }
  await rm(dir, { recursive: true, force: true });
});

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    source: 'dsh',
    model: 'deepseek-v4-pro',
    timestamp: NOW - HOUR,
    inputTokens: 900,
    outputTokens: 100,
    cacheWriteTokens: 0,
    cacheReadTokens: 2000,
    ...overrides
  };
}

describe('appendUsageEvent / readUsageEvents', () => {
  it('appends one JSON line per event and reads them back', async () => {
    await appendUsageEvent(event());
    await appendUsageEvent(event({ timestamp: NOW - 2 * HOUR, model: 'other' }));

    const text = await readFile(getUsageEventsPath(), 'utf8');
    expect(text.split('\n').filter(Boolean)).toHaveLength(2);

    const events = await readUsageEvents('dsh', NOW - 3 * HOUR, NOW);
    expect(events).toHaveLength(2);
    expect(events[0]?.model).toBe('deepseek-v4-pro');
    expect(events[1]?.model).toBe('other');
  });

  it('filters by source and window', async () => {
    await appendUsageEvent(event({ timestamp: NOW - HOUR }));
    await appendUsageEvent(event({ source: 'codex', timestamp: NOW - HOUR }));
    await appendUsageEvent(event({ timestamp: NOW - 5 * HOUR }));

    const events = await readUsageEvents('dsh', NOW - 2 * HOUR, NOW);
    expect(events).toHaveLength(1);
    expect(events[0]?.timestamp).toBe(NOW - HOUR);
  });

  it('returns an empty list when the log is missing', async () => {
    await expect(readUsageEvents('dsh', 0, NOW)).resolves.toEqual([]);
  });
});

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
