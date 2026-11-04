import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { loadState, normalizeState, saveState } from './state-store.js';
import { createEmptyState, type PresenceState } from './state.js';

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

async function writeRaw(raw: unknown): Promise<void> {
  await writeFile(statePath, JSON.stringify(raw), { mode: 0o600 });
}

async function readRaw(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
}

describe('queue fields in the state file', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-presence-queue-state-'));
    statePath = join(dir, 'state.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes back owed work it does not know unchanged, next to its own changes', async () => {
    await writeRaw({ sessions: {}, queueApplied: ['r0', 'r1'], queueOwed: laterOwed });

    const state = await loadState(statePath);
    state.queueApplied?.push('r2');
    state.lastValue = '1 agent';
    await saveState(state, statePath);

    const saved = await readRaw();
    expect(saved.queueOwed).toEqual(laterOwed);
    expect(saved.queueApplied).toEqual(['r0', 'r1', 'r2']);
    expect(saved.lastValue).toBe('1 agent');
  });

  it('keeps the unknown fields of a known entry it changes in place', async () => {
    await writeRaw({ sessions: {}, queueOwed: laterOwed });

    const state = await loadState(statePath);
    const entry = state.queueOwed?.usageRefresh?.[0];
    expect(entry?.source).toBe('claude');
    if (entry) {
      entry.generation += 1;
      entry.boundaryAt = 1_760_000_009_000;
    }
    await saveState(state, statePath);

    const saved = await readRaw();
    expect(saved.queueOwed).toEqual({
      ...laterOwed,
      usageRefresh: [
        { ...laterOwed.usageRefresh[0], generation: 4, boundaryAt: 1_760_000_009_000 },
        laterOwed.usageRefresh[1]
      ]
    });
  });

  it.each([
    ['not an object', 'owed', ['r1']],
    ['a list', [laterOwed], 'not-a-list']
  ])('loads queueOwed that is %s as absent, and keeps the other fields', async (_name, queueOwed, queueApplied) => {
    await writeRaw({ sessions: {}, lastValue: 'kept', queueOwed, queueApplied });

    const state = await loadState(statePath);
    expect(state.queueOwed).toBeUndefined();
    expect(state.lastValue).toBe('kept');
    expect(state.queueApplied).toEqual(Array.isArray(queueApplied) ? queueApplied : undefined);
  });

  it('still drops other top-level fields it does not know', async () => {
    await writeRaw({ sessions: {}, queueOwed: laterOwed, laterReleaseField: { kept: false } });
    await saveState(await loadState(statePath), statePath);

    const saved = await readRaw();
    expect(saved).not.toHaveProperty('laterReleaseField');
    expect(saved.queueOwed).toEqual(laterOwed);
  });

  it('saves no queue fields for a state that has none', async () => {
    await writeRaw({ sessions: {}, lastValue: '' });
    await saveState(await loadState(statePath), statePath);

    const saved = await readRaw();
    expect(saved).not.toHaveProperty('queueApplied');
    expect(saved).not.toHaveProperty('queueOwed');
  });
});

describe('normalizeState usage badge cache', () => {
  it('preserves the per-window badge cache across a load/normalize round trip', () => {
    const raw: PresenceState = {
      ...createEmptyState(),
      usageBadges: { '1': '2.1M · $4.50', '7': '13M · $30.00' },
      usageBadgesAt: 1700
    };
    const normalized = normalizeState(raw);
    expect(normalized.usageBadges).toEqual({ '1': '2.1M · $4.50', '7': '13M · $30.00' });
    expect(normalized.usageBadgesAt).toBe(1700);
  });

  it('preserves valid source snapshots and drops malformed contributions', () => {
    const raw = {
      ...createEmptyState(),
      usageSnapshots: {
        '1': {
          codex: { totalTokens: 100, costUsd: 1.25, scannedAt: 1700 },
          broken: { totalTokens: -1, costUsd: 1, scannedAt: 1700 }
        },
        bad: {
          claude: { totalTokens: 200, costUsd: 2, scannedAt: 1700 }
        }
      }
    } as PresenceState;

    expect(normalizeState(raw).usageSnapshots).toEqual({
      '1': {
        codex: { totalTokens: 100, costUsd: 1.25, scannedAt: 1700 }
      }
    });
  });

  it('drops malformed cache entries and fields', () => {
    const raw = {
      ...createEmptyState(),
      usageBadges: { '1': '2.1M', bad: '5M', '7': 123 },
      usageBadgesAt: 'soon'
    } as unknown as PresenceState;
    const normalized = normalizeState(raw);
    expect(normalized.usageBadges).toEqual({ '1': '2.1M' });
    expect(normalized.usageBadgesAt).toBeUndefined();
  });
});
