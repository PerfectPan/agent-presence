import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendUsageEvent, type UsageEvent } from '../src/usage-events.js';
import { scanDsh } from '../src/usage/scan-dsh.js';

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

let dir: string;
let eventsFile: string;
let savedEventsFile: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-presence-dsh-'));
  eventsFile = join(dir, 'usage-events.log');
  savedEventsFile = process.env.AGENT_PRESENCE_USAGE_EVENTS_FILE;
  process.env.AGENT_PRESENCE_USAGE_EVENTS_FILE = eventsFile;
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

describe('scanDsh', () => {
  it('returns an empty list when no usage events exist', async () => {
    const records = await scanDsh({ root: '', sinceMs: NOW - HOUR, untilMs: NOW });
    expect(records).toEqual([]);
  });

  it('maps ingested dsh events to usage records for the window', async () => {
    await appendUsageEvent(event());
    await appendUsageEvent(event({ timestamp: NOW - 5 * HOUR, inputTokens: 500 }));
    await appendUsageEvent(event({ source: 'codex', model: 'gpt-5.5' }));

    const records = await scanDsh({ root: '', sinceMs: NOW - 2 * HOUR, untilMs: NOW });
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      source: 'dsh',
      model: 'deepseek-v4-pro',
      timestamp: NOW - HOUR,
      inputTokens: 900,
      outputTokens: 100,
      cacheWriteTokens: 0,
      cacheReadTokens: 2000,
      costUsd: null
    });
  });

  it('skips corrupt lines', async () => {
    await appendUsageEvent(event());
    await writeFile(eventsFile, '{ broken\n', { flag: 'a' });

    const records = await scanDsh({ root: '', sinceMs: NOW - 2 * HOUR, untilMs: NOW });
    expect(records).toHaveLength(1);
  });
});
