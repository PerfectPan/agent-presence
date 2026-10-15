import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import { collectWindowUsage, type BillableSource, type UsageRecord } from '../src/usage/index.js';

// Use real "now" so the calendar-window math below is relative and stable
// regardless of the host time zone.
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-presence-usage-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A scanner record at the four-bucket shape a custom handler (or dsh) returns. */
function record(partial: Partial<UsageRecord>): UsageRecord {
  return {
    source: 'handler',
    model: 'test-model',
    timestamp: NOW - 1000,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    costUsd: null,
    ...partial
  };
}

function handlerSource(id: string, records: UsageRecord[]): BillableSource {
  return { id, scanUsage: async () => records };
}

describe('collectWindowUsage', () => {
  it('aggregates across sources with per-source and total cost', async () => {
    const window = await collectWindowUsage({
      days: 1,
      now: NOW,
      sources: [
        handlerSource('alpha', [record({ model: 'priced-model', inputTokens: 1_000_000, costUsd: null })]),
        handlerSource('beta', [record({ costUsd: 1.5 })])
      ],
      pricing: { 'priced-model': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } }
    });

    const alpha = window.bySource.find((s) => s.source === 'alpha');
    // 1M input at $5/MTok through the kit's pricing; the converted record's
    // cache-inclusive input is what the badge total reports.
    expect(alpha?.inputTokens).toBe(1_000_000);
    expect(alpha?.totalTokens).toBe(1_000_000);
    expect(alpha?.costUsd).toBeCloseTo(5, 5);
    expect(window.total.costUsd).toBeCloseTo(6.5, 5);
    const startOfToday = new Date(NOW);
    startOfToday.setHours(0, 0, 0, 0);
    expect(window.sinceMs).toBe(startOfToday.getTime()); // calendar-day: snaps to local midnight
    expect(window.untilMs).toBe(NOW);
  });

  it('a 7-day window starts at local midnight six days before today', async () => {
    const window = await collectWindowUsage({ days: 7, now: NOW, sources: [] });
    const startOfToday = new Date(NOW);
    startOfToday.setHours(0, 0, 0, 0);
    expect(window.sinceMs).toBe(startOfToday.getTime() - 6 * DAY);
    expect(window.untilMs).toBe(NOW);
  });

  it('converts handler records to the kit shape at the totals boundary (cache back into input)', async () => {
    const window = await collectWindowUsage({
      days: 1,
      now: NOW,
      sources: [
        handlerSource('handler', [
          record({
            model: 'priced-model',
            inputTokens: 100,
            outputTokens: 20,
            cacheWriteTokens: 5,
            cacheReadTokens: 50
          })
        ])
      ],
      pricing: { 'priced-model': { input: 2, output: 8, cacheWrite: 2.5, cacheRead: 0.2 } }
    });

    const group = window.bySource[0]!;
    // Kit input adds the cache counts back; the total is the kit's two-bucket sum.
    expect(group.inputTokens).toBe(155);
    expect(group.outputTokens).toBe(20);
    expect(group.cacheWriteTokens).toBe(5);
    expect(group.cacheReadTokens).toBe(50);
    expect(group.totalTokens).toBe(175);
    expect(group.entries).toBe(1);
    // (100*2 + 20*8 + 5*2.5 + 50*0.2) / 1e6 — cached input is not charged at the input rate.
    expect(group.costUsd).toBeCloseTo((200 + 160 + 12.5 + 10) / 1_000_000, 10);
    expect(window.total.totalTokens).toBe(175);
  });

  it('applies a record multiplier to a table cost but not to a logged cost', async () => {
    const window = await collectWindowUsage({
      days: 1,
      now: NOW,
      sources: [
        handlerSource('handler', [
          record({ model: 'priced-model', inputTokens: 1_000_000, pricingMultiplier: 2 }),
          record({ model: 'priced-model', inputTokens: 1_000_000, costUsd: 3, pricingMultiplier: 2 })
        ])
      ],
      pricing: { 'priced-model': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } }
    });

    expect(window.total.costUsd).toBeCloseTo(10 + 3, 8);
  });

  it('keeps a logged zero cost and reports n/a only when nothing is priced', async () => {
    const window = await collectWindowUsage({
      days: 1,
      now: NOW,
      sources: [
        handlerSource('logged-zero', [record({ costUsd: 0 })]),
        handlerSource('unknown-model', [record({ model: 'mystery-model', inputTokens: 42 })])
      ]
    });

    expect(window.bySource[0]).toMatchObject({ costUsd: 0, totalTokens: 0 });
    // An unknown model keeps its tokens exact and leaves the cost absent.
    expect(window.bySource[1]).toMatchObject({ totalTokens: 42, costUsd: null });
    expect(window.total.costUsd).toBe(0);
  });

  it('iterates the given sources dynamically, in order, one row per source', async () => {
    const fakeA = handlerSource('alpha', [record({ inputTokens: 3, costUsd: 1.5 })]);
    const fakeB: BillableSource = { id: 'beta', scanUsage: async () => [] };

    const window = await collectWindowUsage({ days: 1, now: NOW, sources: [fakeA, fakeB] });
    expect(window.bySource.map((s) => s.source)).toEqual(['alpha', 'beta']);
    expect(window.bySource[0]).toMatchObject({ entries: 1, totalTokens: 3, costUsd: 1.5 });
    expect(window.bySource[1]).toMatchObject({ entries: 0, totalTokens: 0, costUsd: null });
    expect(window.total.costUsd).toBeCloseTo(1.5, 5);
  });

  it('with no billable sources, contributes nothing (empty bySource, null cost)', async () => {
    const window = await collectWindowUsage({ days: 1, now: NOW, sources: [] });
    expect(window.bySource).toEqual([]);
    expect(window.total.totalTokens).toBe(0);
    expect(window.total.costUsd).toBeNull();
  });

  it('isolates a throwing source: it contributes nothing but others still count', async () => {
    const boom: BillableSource = {
      id: 'boom',
      scanUsage: async () => {
        throw new Error('unreadable transcript store');
      }
    };
    const ok = handlerSource('ok', [record({ inputTokens: 7, costUsd: 0.25 })]);

    const window = await collectWindowUsage({ days: 1, now: NOW, sources: [boom, ok] });
    expect(window.bySource.map((s) => s.source)).toEqual(['boom', 'ok']);
    expect(window.bySource[0]).toMatchObject({ entries: 0, totalTokens: 0 });
    expect(window.bySource[1]).toMatchObject({ entries: 1, totalTokens: 7 });
    expect(window.total.totalTokens).toBe(7);
  });
});
