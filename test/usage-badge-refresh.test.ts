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

  it('builds a complete cache when the aggregate timestamp is missing', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-presence-usage-badge-'));
    const statePath = join(dir, 'state.json');
    await saveState(
      {
        sessions: {},
        usageBadges: { '1': '300 · $3.00' },
        usageSnapshots: {
          '1': {
            codex: { totalTokens: 100, costUsd: 1, scannedAt: NOW - 1000 },
            claude: { totalTokens: 200, costUsd: 2, scannedAt: NOW - 1000 }
          }
        }
      },
      statePath
    );

    const codexScan = vi.fn(async () => [record('codex', 20, 0.2)]);
    const claudeScan = vi.fn(async () => [record('claude', 30, 0.3)]);
    await refreshUsageBadgeCache({
      statePath,
      now: NOW,
      windows: [1],
      sources: [
        { id: 'codex', scanUsage: codexScan },
        { id: 'claude', scanUsage: claudeScan }
      ],
      source: 'codex'
    });

    expect(codexScan).toHaveBeenCalledTimes(1);
    expect(claudeScan).toHaveBeenCalledTimes(1);
    expect(await loadState(statePath)).toMatchObject({
      usageBadges: { '1': '50 · $0.50' },
      usageBadgesAt: NOW,
      usageSnapshots: {
        '1': {
          codex: { totalTokens: 20, costUsd: 0.2, scannedAt: NOW },
          claude: { totalTokens: 30, costUsd: 0.3, scannedAt: NOW }
        }
      }
    });
  });

  it('performs a full refresh at the first source boundary after midnight', async () => {
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

    const codexScan = vi.fn(async () => [record('codex', 20, 0.2)]);
    const claudeScan = vi.fn(async () => [record('claude', 30, 0.3)]);
    const opencodeScan = vi.fn(async () => []);
    const sources: BillableSource[] = [
      { id: 'codex', scanUsage: codexScan },
      { id: 'claude', scanUsage: claudeScan },
      { id: 'opencode', scanUsage: opencodeScan }
    ];

    await refreshUsageBadgeCache({ statePath, now: today, windows: [1], sources, source: 'codex' });

    expect(codexScan).toHaveBeenCalledTimes(1);
    expect(claudeScan).toHaveBeenCalledTimes(1);
    expect(opencodeScan).toHaveBeenCalledTimes(1);
    expect(await loadState(statePath)).toMatchObject({
      usageBadges: { '1': '50 · $0.50' },
      usageBadgesAt: today,
      usageSnapshots: {
        '1': {
          codex: { totalTokens: 20, costUsd: 0.2, scannedAt: today },
          claude: { totalTokens: 30, costUsd: 0.3, scannedAt: today },
          opencode: { totalTokens: 0, costUsd: null, scannedAt: today }
        }
      }
    });
  });

  it('keeps the previous cache incomplete when a promoted source scan fails', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-presence-usage-badge-'));
    const statePath = join(dir, 'state.json');
    const yesterday = new Date(2026, 6, 14, 23, 59).getTime();
    const today = new Date(2026, 6, 15, 0, 1).getTime();
    await saveState(
      {
        sessions: {},
        usageBadges: { '1': '300 · $3.00' },
        usageBadgesAt: yesterday,
        usageSnapshots: {
          '1': {
            codex: { totalTokens: 100, costUsd: 1, scannedAt: yesterday },
            claude: { totalTokens: 200, costUsd: 2, scannedAt: yesterday }
          }
        }
      },
      statePath
    );

    const codexScan = vi.fn(async () => [record('codex', 20, 0.2)]);
    const claudeScan = vi.fn(async () => {
      throw new Error('temporarily unreadable');
    });
    await refreshUsageBadgeCache({
      statePath,
      now: today,
      windows: [1],
      sources: [
        { id: 'codex', scanUsage: codexScan },
        { id: 'claude', scanUsage: claudeScan }
      ],
      source: 'codex'
    });

    expect(codexScan).toHaveBeenCalledTimes(1);
    expect(claudeScan).toHaveBeenCalledTimes(1);
    expect(await loadState(statePath)).toMatchObject({
      usageBadges: { '1': '300 · $3.00' },
      usageBadgesAt: yesterday,
      usageSnapshots: {
        '1': {
          codex: { totalTokens: 100, costUsd: 1, scannedAt: yesterday },
          claude: { totalTokens: 200, costUsd: 2, scannedAt: yesterday }
        }
      }
    });
  });

  it('does not let an older overlapping refresh overwrite newer usage', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-presence-usage-badge-'));
    const statePath = join(dir, 'state.json');
    const yesterday = new Date(2026, 6, 14, 23, 59).getTime();
    const olderBoundary = new Date(2026, 6, 15, 0, 1).getTime();
    const newerBoundary = new Date(2026, 6, 15, 0, 2).getTime();
    await saveState(
      {
        sessions: {},
        usageBadges: { '1': '100 · $1.00' },
        usageBadgesAt: yesterday,
        usageSnapshots: {
          '1': { codex: { totalTokens: 100, costUsd: 1, scannedAt: yesterday } }
        }
      },
      statePath
    );

    const oldScanStarted = deferred();
    const releaseOldScan = deferred();
    const codexScan = vi.fn(async ({ untilMs }: { untilMs: number }) => {
      if (untilMs === olderBoundary) {
        oldScanStarted.resolve();
        await releaseOldScan.promise;
        return [record('codex', 10, 0.1)];
      }
      return [record('codex', 20, 0.2)];
    });
    const sources: BillableSource[] = [{ id: 'codex', scanUsage: codexScan }];

    const olderRefresh = refreshUsageBadgeCache({
      statePath,
      now: olderBoundary,
      windows: [1],
      sources,
      source: 'codex'
    });
    await oldScanStarted.promise;

    await refreshUsageBadgeCache({
      statePath,
      now: newerBoundary,
      windows: [1],
      sources,
      source: 'codex'
    });
    releaseOldScan.resolve();
    await olderRefresh;

    expect(codexScan).toHaveBeenCalledTimes(2);
    expect(await loadState(statePath)).toMatchObject({
      usageBadges: { '1': '20 · $0.20' },
      usageBadgesAt: newerBoundary,
      usageSnapshots: {
        '1': { codex: { totalTokens: 20, costUsd: 0.2, scannedAt: newerBoundary } }
      }
    });
  });

  it('promotes only the first boundary and refreshes every configured window', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-presence-usage-badge-'));
    const statePath = join(dir, 'state.json');
    const yesterday = new Date(2026, 6, 14, 23, 59).getTime();
    const firstBoundary = new Date(2026, 6, 15, 0, 1).getTime();
    const secondBoundary = new Date(2026, 6, 15, 0, 2).getTime();
    await saveState(
      {
        sessions: {},
        usageBadges: { '1': '350 · $3.50', '7': '3.5K · $35.00' },
        usageBadgesAt: yesterday,
        usageSnapshots: {
          '1': {
            codex: { totalTokens: 100, costUsd: 1, scannedAt: yesterday },
            claude: { totalTokens: 200, costUsd: 2, scannedAt: yesterday },
            opencode: { totalTokens: 50, costUsd: 0.5, scannedAt: yesterday }
          },
          '7': {
            codex: { totalTokens: 1_000, costUsd: 10, scannedAt: yesterday },
            claude: { totalTokens: 2_000, costUsd: 20, scannedAt: yesterday },
            opencode: { totalTokens: 500, costUsd: 5, scannedAt: yesterday }
          }
        }
      },
      statePath
    );

    const codexScan = vi.fn(async () => [record('codex', 20, 0.2)]);
    const claudeScan = vi.fn(async () => [record('claude', 30, 0.3)]);
    const opencodeScan = vi.fn(async () => [] as UsageRecord[]);
    const sources: BillableSource[] = [
      { id: 'codex', scanUsage: codexScan },
      { id: 'claude', scanUsage: claudeScan },
      { id: 'opencode', scanUsage: opencodeScan }
    ];

    await refreshUsageBadgeCache({
      statePath,
      now: firstBoundary,
      windows: [1, 7],
      sources,
      source: 'codex'
    });

    expect(codexScan).toHaveBeenCalledTimes(2);
    expect(claudeScan).toHaveBeenCalledTimes(2);
    expect(opencodeScan).toHaveBeenCalledTimes(2);
    expect(await loadState(statePath)).toMatchObject({
      usageBadges: { '1': '50 · $0.50', '7': '50 · $0.50' },
      usageBadgesAt: firstBoundary,
      usageSnapshots: {
        '1': {
          codex: { totalTokens: 20, costUsd: 0.2, scannedAt: firstBoundary },
          claude: { totalTokens: 30, costUsd: 0.3, scannedAt: firstBoundary },
          opencode: { totalTokens: 0, costUsd: null, scannedAt: firstBoundary }
        },
        '7': {
          codex: { totalTokens: 20, costUsd: 0.2, scannedAt: firstBoundary },
          claude: { totalTokens: 30, costUsd: 0.3, scannedAt: firstBoundary },
          opencode: { totalTokens: 0, costUsd: null, scannedAt: firstBoundary }
        }
      }
    });

    vi.clearAllMocks();
    opencodeScan.mockResolvedValue([record('opencode', 10, 0.1)]);
    await refreshUsageBadgeCache({
      statePath,
      now: secondBoundary,
      windows: [1, 7],
      sources,
      source: 'opencode'
    });

    expect(codexScan).not.toHaveBeenCalled();
    expect(claudeScan).not.toHaveBeenCalled();
    expect(opencodeScan).toHaveBeenCalledTimes(2);
    expect(await loadState(statePath)).toMatchObject({
      usageBadges: { '1': '60 · $0.60', '7': '60 · $0.60' },
      usageBadgesAt: secondBoundary,
      usageSnapshots: {
        '1': {
          codex: { totalTokens: 20, costUsd: 0.2, scannedAt: firstBoundary },
          claude: { totalTokens: 30, costUsd: 0.3, scannedAt: firstBoundary },
          opencode: { totalTokens: 10, costUsd: 0.1, scannedAt: secondBoundary }
        },
        '7': {
          codex: { totalTokens: 20, costUsd: 0.2, scannedAt: firstBoundary },
          claude: { totalTokens: 30, costUsd: 0.3, scannedAt: firstBoundary },
          opencode: { totalTokens: 10, costUsd: 0.1, scannedAt: secondBoundary }
        }
      }
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
