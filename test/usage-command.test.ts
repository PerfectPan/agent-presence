import { describe, expect, it } from 'vitest';

import { orderedSources, renderUsageTable } from '../src/cli/commands/usage.js';
import type { SourceUsage, WindowUsage } from '../src/usage/index.js';

function sourceUsage(source: string, totalTokens: number, costUsd: number | null): SourceUsage {
  return {
    source,
    entries: totalTokens > 0 ? 1 : 0,
    inputTokens: totalTokens,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    totalTokens,
    costUsd
  };
}

function window(bySource: SourceUsage[]): WindowUsage {
  const totalTokens = bySource.reduce((sum, s) => sum + s.totalTokens, 0);
  const costs = bySource.map((s) => s.costUsd).filter((c): c is number => c !== null);
  return {
    sinceMs: 0,
    untilMs: 1,
    bySource,
    total: {
      inputTokens: totalTokens,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      totalTokens,
      costUsd: costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null
    }
  };
}

describe('orderedSources', () => {
  it('takes the union of source ids across windows, in first-seen order', () => {
    const w1 = window([sourceUsage('codex', 10, 1), sourceUsage('claude', 20, 2)]);
    // A second window introduces a new id after the shared ones.
    const w7 = window([sourceUsage('codex', 30, 3), sourceUsage('claude', 40, 4), sourceUsage('opencode', 50, 5)]);
    expect(orderedSources([w1, w7])).toEqual(['codex', 'claude', 'opencode']);
  });

  it('is empty when no source produced usage', () => {
    expect(orderedSources([window([])])).toEqual([]);
  });
});

describe('renderUsageTable', () => {
  it('renders one row per source in merged-table order, labelled by source id', () => {
    const windows = [window([sourceUsage('codex', 12_300, 1.5), sourceUsage('opencode', 2_100_000, 43.53)])];
    const table = renderUsageTable([1], windows);

    const lines = table.split('\n');
    expect(lines[0]).toContain('agent-presence usage');
    // Header, then a row per source in the order the window reported them.
    const codexRow = lines.find((l) => l.startsWith('codex'));
    const opencodeRow = lines.find((l) => l.startsWith('opencode'));
    expect(codexRow).toBeDefined();
    expect(opencodeRow).toBeDefined();
    expect(lines.indexOf(codexRow!)).toBeLessThan(lines.indexOf(opencodeRow!));
    // The label is the raw source id, and tokens/cost are formatted compactly.
    expect(codexRow).toContain('12.3K');
    expect(codexRow).toContain('$1.50');
    // No stale "gemini not tracked" footer any more.
    expect(table).not.toContain('not tracked');
  });

  it('renders an unknown/config source id as its own label without crashing', () => {
    const windows = [window([sourceUsage('myagent', 500, null)])];
    const table = renderUsageTable([1], windows);
    const row = table.split('\n').find((l) => l.startsWith('myagent'));
    expect(row).toBeDefined();
    // Unknown cost renders as n/a, token count is exact.
    expect(row).toContain('500');
    expect(row).toContain('n/a');
  });

  it('shows a per-window tokens/cost column pair for each window', () => {
    const windows = [
      window([sourceUsage('codex', 10, 1)]),
      window([sourceUsage('codex', 70, 7)])
    ];
    const table = renderUsageTable([1, 7], windows);
    const header = table.split('\n').find((l) => l.startsWith('source'));
    expect(header).toContain('last 1d tokens');
    expect(header).toContain('last 1d cost');
    expect(header).toContain('last 7d tokens');
    expect(header).toContain('last 7d cost');
    // The total row aggregates each window.
    const totalRow = table.split('\n').find((l) => l.startsWith('total'));
    expect(totalRow).toBeDefined();
  });
});
