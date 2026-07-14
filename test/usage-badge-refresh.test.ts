import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { refreshUsageBadgeCache } from '../src/cli/usage-badge.js';
import { loadState, saveState, type PresenceState } from '../src/state.js';
import type { BillableSource, UsageRecord } from '../src/usage/index.js';

const NOW = new Date('2026-07-14T13:00:00+08:00').getTime();

let dir: string | undefined;

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe('refreshUsageBadgeCache', () => {
  it('refreshes only the hook source and preserves the other source contributions', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-presence-usage-badge-'));
    const statePath = join(dir, 'state.json');
    await saveState(
      {
        sessions: {},
        usageBadges: { '1': '300 · $3.00' },
        usageBadgesAt: NOW - 1000,
        usageSnapshots: {
          '1': {
            codex: { totalTokens: 100, costUsd: 1, scannedAt: NOW - 1000 },
            claude: { totalTokens: 200, costUsd: 2, scannedAt: NOW - 1000 },
            removed: { totalTokens: 10_000, costUsd: 100, scannedAt: NOW - 1000 }
          }
        }
      } as PresenceState,
      statePath
    );

    const codexScan = vi.fn(async () => [record('codex', 9_999, 99)]);
    const claudeScan = vi.fn(async () => [record('claude', 9_999, 99)]);
    const opencodeScan = vi.fn(async () => [record('opencode', 50, 0.5)]);
    const sources: BillableSource[] = [
      { id: 'codex', scanUsage: codexScan },
      { id: 'claude', scanUsage: claudeScan },
      { id: 'opencode', scanUsage: opencodeScan }
    ];

    await refreshUsageBadgeCache({
      statePath,
      now: NOW,
      windows: [1],
      sources,
      source: 'opencode'
    });

    expect(codexScan).not.toHaveBeenCalled();
    expect(claudeScan).not.toHaveBeenCalled();
    expect(opencodeScan).toHaveBeenCalledTimes(1);
    expect(await loadState(statePath)).toMatchObject({
      usageBadges: { '1': '350 · $3.50' },
      usageBadgesAt: NOW,
      usageSnapshots: {
        '1': {
          codex: { totalTokens: 100, costUsd: 1, scannedAt: NOW - 1000 },
          claude: { totalTokens: 200, costUsd: 2, scannedAt: NOW - 1000 },
          opencode: { totalTokens: 50, costUsd: 0.5, scannedAt: NOW }
        }
      }
    });
  });

  it('uses an explicit refresh to scan every source and replace the snapshot set', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-presence-usage-badge-'));
    const statePath = join(dir, 'state.json');
    await saveState(
      {
        sessions: {},
        usageSnapshots: {
          '1': {
            codex: { totalTokens: 1, costUsd: 0.01, scannedAt: NOW - 1000 },
            removed: { totalTokens: 10_000, costUsd: 100, scannedAt: NOW - 1000 }
          }
        }
      },
      statePath
    );

    const codexScan = vi.fn(async () => [record('codex', 120, 1.2)]);
    const claudeScan = vi.fn(async () => [record('claude', 230, 2.3)]);
    await refreshUsageBadgeCache({
      statePath,
      now: NOW,
      windows: [1],
      sources: [
        { id: 'codex', scanUsage: codexScan },
        { id: 'claude', scanUsage: claudeScan }
      ]
    });

    expect(codexScan).toHaveBeenCalledTimes(1);
    expect(claudeScan).toHaveBeenCalledTimes(1);
    expect(await loadState(statePath)).toMatchObject({
      usageBadges: { '1': '350 · $3.50' },
      usageBadgesAt: NOW,
      usageSnapshots: {
        '1': {
          codex: { totalTokens: 120, costUsd: 1.2, scannedAt: NOW },
          claude: { totalTokens: 230, costUsd: 2.3, scannedAt: NOW }
        }
      }
    });
    expect((await loadState(statePath)).usageSnapshots?.['1']).not.toHaveProperty('removed');
  });

  it('does not replace an aggregate badge with a partial source snapshot during migration', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-presence-usage-badge-'));
    const statePath = join(dir, 'state.json');
    await saveState(
      {
        sessions: {},
        usageBadges: { '1': '300 · $3.00', '7': '2K · $20.00' },
        usageBadgesAt: NOW - 1000,
        usageSnapshots: {
          '1': {
            codex: { totalTokens: 100, costUsd: 1, scannedAt: NOW - 1000 },
            claude: { totalTokens: 200, costUsd: 2, scannedAt: NOW - 1000 }
          }
        }
      },
      statePath
    );

    const opencodeScan = vi.fn(async () => [record('opencode', 50, 0.5)]);
    await refreshUsageBadgeCache({
      statePath,
      now: NOW,
      windows: [1, 7],
      sources: [
        { id: 'codex', scanUsage: vi.fn(async () => []) },
        { id: 'claude', scanUsage: vi.fn(async () => []) },
        { id: 'opencode', scanUsage: opencodeScan }
      ],
      source: 'opencode'
    });

    expect(await loadState(statePath)).toMatchObject({
      usageBadges: { '1': '350 · $3.50', '7': '2K · $20.00' },
      usageBadgesAt: NOW - 1000,
      usageSnapshots: {
        '1': {
          codex: { totalTokens: 100, costUsd: 1, scannedAt: NOW - 1000 },
          claude: { totalTokens: 200, costUsd: 2, scannedAt: NOW - 1000 },
          opencode: { totalTokens: 50, costUsd: 0.5, scannedAt: NOW }
        },
        '7': {
          opencode: { totalTokens: 50, costUsd: 0.5, scannedAt: NOW }
        }
      }
    });
  });

  it('does not combine source snapshots from different calendar days', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-presence-usage-badge-'));
    const statePath = join(dir, 'state.json');
    const yesterday = new Date(2026, 6, 14, 23, 59).getTime();
    const today = new Date(2026, 6, 15, 0, 1).getTime();
    await saveState(
      {
        sessions: {},
        usageBadges: { '1': '350 · $3.50' },
        usageBadgesAt: yesterday,
        usageSnapshots: {
          '1': {
            codex: { totalTokens: 100, costUsd: 1, scannedAt: yesterday },
            claude: { totalTokens: 200, costUsd: 2, scannedAt: yesterday },
            opencode: { totalTokens: 50, costUsd: 0.5, scannedAt: yesterday }
          }
        }
      },
      statePath
    );

    const sources: BillableSource[] = [
      { id: 'codex', scanUsage: vi.fn(async () => [record('codex', 20, 0.2)]) },
      { id: 'claude', scanUsage: vi.fn(async () => [record('claude', 30, 0.3)]) },
      { id: 'opencode', scanUsage: vi.fn(async () => [record('opencode', 10, 0.1)]) }
    ];

    await refreshUsageBadgeCache({ statePath, now: today, windows: [1], sources, source: 'opencode' });
    expect(await loadState(statePath)).toMatchObject({
      usageBadges: { '1': '350 · $3.50' },
      usageBadgesAt: yesterday
    });

    await refreshUsageBadgeCache({ statePath, now: today, windows: [1], sources, source: 'codex' });
    expect(await loadState(statePath)).toMatchObject({
      usageBadges: { '1': '350 · $3.50' },
      usageBadgesAt: yesterday
    });

    await refreshUsageBadgeCache({ statePath, now: today, windows: [1], sources, source: 'claude' });
    expect(await loadState(statePath)).toMatchObject({
      usageBadges: { '1': '60 · $0.60' },
      usageBadgesAt: today
    });
  });
});

function record(source: string, totalTokens: number, costUsd: number): UsageRecord {
  return {
    source,
    model: 'test-model',
    timestamp: NOW - 1,
    inputTokens: totalTokens,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    costUsd
  };
}
