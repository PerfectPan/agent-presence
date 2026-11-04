import { mkdirSync } from 'node:fs';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vite-plus/test';

import { printUsage } from '../src/cli/commands/usage.js';
import type { WindowUsage } from '../src/usage/index.js';

describe('printUsage --json', () => {
  it('reports inputTokens without the cache and totalTokens as the cache-inclusive input plus output', async () => {
    // The command reads the wall clock for its window; the clock is faked to
    // half a second past local midnight, where a record timed relative to the
    // real now would fall on the previous day. Everything the test changes is
    // restored in the finally below.
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
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 6, 14, 0, 0, 0, 500));
      for (const name of names) {
        saved[name] = process.env[name];
        process.env[name] = home;
      }
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
