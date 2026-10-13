import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import type { UsageEvent } from '../src/usage-events.js';
import { appendUsageEvent, getUsageEventsPath, readUsageEvents } from '../src/usage-events-log.js';

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

  it('writes the record id with the event and counts a repeated id once', async () => {
    await appendUsageEvent(event(), { id: 'record-1' });
    await appendUsageEvent(event(), { id: 'record-1' });
    await appendUsageEvent(event({ model: 'other' }), { id: 'record-2' });

    const lines = (await readFile(getUsageEventsPath(), 'utf8')).trim().split('\n');
    expect(JSON.parse(lines[0] ?? '')).toEqual({ ...event(), id: 'record-1' });
    const events = await readUsageEvents('dsh', NOW - 3 * HOUR, NOW);
    expect(events).toEqual([event(), event({ model: 'other' })]);
  });

  it('reads untrusted lines leniently and skips those without a source or timestamp', async () => {
    const lines = [
      { source: 'dsh', timestamp: NOW - HOUR, model: 7, inputTokens: -5, outputTokens: 'x', cacheReadTokens: 40 },
      { timestamp: NOW - HOUR, model: 'no-source', inputTokens: 1 },
      { source: 'dsh', model: 'no-timestamp', inputTokens: 1 }
    ];
    await writeFile(getUsageEventsPath(), lines.map((line) => `${JSON.stringify(line)}\n`).join(''), {
      mode: 0o600
    });

    expect(await readUsageEvents('dsh', NOW - 3 * HOUR, NOW)).toEqual([
      {
        source: 'dsh',
        model: 'unknown',
        timestamp: NOW - HOUR,
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 40
      }
    ]);
  });
});
