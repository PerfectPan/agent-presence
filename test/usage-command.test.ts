import { mkdirSync } from 'node:fs';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vite-plus/test';

import { orderedSources, printUsage, renderUsageTable } from '../src/cli/commands/usage.js';
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
    const windows = [window([sourceUsage('codex', 10, 1)]), window([sourceUsage('codex', 70, 7)])];
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

describe('printUsage --json', () => {
  it('reports inputTokens without the cache and totalTokens as the cache-inclusive input plus output', async () => {
    // The command reads the wall clock for its window; the clock is faked to
    // half a second past local midnight, where a record timed relative to the
    // real now would fall on the previous day.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 6, 14, 0, 0, 0, 500));
    const home = await mkdtemp(join(tmpdir(), 'agent-presence-usage-json-'));
    const saved: Record<string, string | undefined> = {};
    const names = [
      'AGENT_PRESENCE_HOME',
      'AGENT_PRESENCE_USAGE_EVENTS_FILE',
      'CLAUDE_CONFIG_DIR',
      'CODEX_HOME',
      'GEMINI_CLI_HOME',
      'GROK_HOME',
      'XDG_DATA_HOME',
      'PI_CODING_AGENT_DIR'
    ];
    for (const name of names) {
      saved[name] = process.env[name];
      process.env[name] = home;
    }

    // One completed opencode message with cache reads and writes and a logged
    // cost, timed at the faked date's local midnight from calendar fields —
    // the only moment inside a window that ends half a second past midnight;
    // the assertions pin field meanings, not times or prices.
    const justNow = new Date(2026, 6, 14, 0, 0, 0, 0).getTime();
    const dbPath = join(home, 'opencode', 'opencode.db');
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
    db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
      'msg_1',
      'ses_1',
      justNow,
      justNow,
      JSON.stringify({
        role: 'assistant',
        modelID: 'priced-model',
        cost: 0,
        tokens: {
          input: 100,
          output: 20,
          reasoning: 0,
          cache: { read: 50, write: 5 },
          total: 175
        },
        time: { created: justNow, completed: justNow }
      })
    );
    db.close();
    const at = new Date(justNow);
    await utimes(dbPath, at, at);

    const logged: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    try {
      await printUsage(['--json', '--days', '1']);
    } finally {
      log.mockRestore();
      vi.useRealTimers();
      for (const name of names) {
        if (saved[name] === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = saved[name]!;
        }
      }
      await rm(home, { recursive: true, force: true });
    }

    const payload = JSON.parse(logged[0]!) as WindowUsage[];
    const opencode = payload[0]!.bySource.find((entry) => entry.source === 'opencode');
    // input without the cache; the cache counts are separate fields, subsets of
    // the kit's input; totalTokens is the kit's two-bucket sum (input + output).
    expect(opencode).toMatchObject({
      entries: 1,
      inputTokens: 100,
      outputTokens: 20,
      cacheWriteTokens: 5,
      cacheReadTokens: 50,
      totalTokens: 175
    });
  });
});
