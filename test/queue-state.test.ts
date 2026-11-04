import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { loadState } from '../src/state-store.js';
import { appendUsageEvent, getUsageEventsPath, readUsageEvents } from '../src/usage-events-log.js';

// These tests act as an older queue release: the state they load was saved by a later release, with owed work this
// release does not know.

const usage = {
  source: 'dsh',
  model: 'deepseek-v4-pro',
  timestamp: 1_760_000_000_000,
  inputTokens: 900,
  outputTokens: 100,
  cacheWriteTokens: 0,
  cacheReadTokens: 2000
};

const laterOwed = {
  dshUsage: [{ id: 'r1', usage: { ...usage, costUsd: 0.25, tier: { name: 'priority' } }, attempts: 2 }],
  usageRefresh: [
    {
      source: 'claude',
      scanEnv: { CLAUDE_CONFIG_DIR: '/fake-home/.claude', LATER_HOME: '/fake-home/later' },
      boundaryAt: 1_760_000_000_000,
      generation: 3,
      reason: 'boundary'
    },
    // A built-in source this release does not have.
    { source: 'later-agent', scanEnv: { LATER_HOME: '/fake-home/later' }, boundaryAt: 1_760_000_000_500, generation: 1 }
  ],
  renderedSync: true,
  laterKind: [{ anything: { nested: [1, 'two'] } }]
};

let dir: string;
let statePath: string;
let savedEventsFile: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-presence-queue-state-'));
  statePath = join(dir, 'state.json');
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

async function writeRaw(raw: unknown): Promise<void> {
  await writeFile(statePath, JSON.stringify(raw), { mode: 0o600 });
}

describe('queue fields in the state file', () => {
  it('writes the unknown fields of an owed usage into the dsh usage line', async () => {
    await writeRaw({ sessions: {}, queueOwed: laterOwed });
    const entry = (await loadState(statePath)).queueOwed?.dshUsage?.[0];
    expect(entry).toBeDefined();
    if (!entry) {
      return;
    }

    expect(await appendUsageEvent(entry.usage, { id: entry.id })).toBe(true);

    const line = JSON.parse((await readFile(getUsageEventsPath(), 'utf8')).trim()) as unknown;
    expect(line).toEqual({ ...laterOwed.dshUsage[0]?.usage, id: 'r1' });
    expect(await readUsageEvents('dsh', usage.timestamp, usage.timestamp + 1)).toEqual([usage]);
  });
});
