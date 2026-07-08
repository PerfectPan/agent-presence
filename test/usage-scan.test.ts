import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectWindowUsage, type BillableSource, type UsageRecord } from '../src/usage/index.js';
import { scanClaude } from '../src/usage/scan-claude.js';
import { scanCodex } from '../src/usage/scan-codex.js';
import { scanPi } from '../src/usage/scan-pi.js';

// Use real "now" so freshly-written temp files pass the mtime pre-filter in
// listJsonlFiles (which skips files older than the window). Window math is
// relative, so token assertions stay deterministic regardless of the value.
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-presence-usage-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeJsonl(name: string, lines: unknown[]): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, lines.map((line) => JSON.stringify(line)).join('\n'), 'utf8');
  return dir;
}

describe('scanClaude', () => {
  it('extracts usage, filters the window, and de-duplicates by id+requestId', async () => {
    const root = await writeJsonl('session.jsonl', [
      {
        type: 'assistant',
        timestamp: iso(NOW - 1000),
        requestId: 'req_1',
        message: {
          id: 'msg_1',
          model: 'claude-opus-4-8',
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 100
          }
        }
      },
      // duplicate of the first turn (resume/fork) — must be ignored
      {
        type: 'assistant',
        timestamp: iso(NOW - 900),
        requestId: 'req_1',
        message: { id: 'msg_1', model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 20 } }
      },
      // outside the window — must be dropped
      {
        type: 'assistant',
        timestamp: iso(NOW - 3 * DAY),
        requestId: 'req_old',
        message: { id: 'msg_old', model: 'claude-opus-4-8', usage: { input_tokens: 999, output_tokens: 999 } }
      }
    ]);

    const records = await scanClaude({ root, sinceMs: NOW - DAY, untilMs: NOW });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      source: 'claude',
      model: 'claude-opus-4-8',
      inputTokens: 10,
      outputTokens: 20,
      cacheWriteTokens: 5,
      cacheReadTokens: 100,
      costUsd: null
    });
  });

  it('keeps the final (largest) occurrence when streaming rewrites output (matches ccusage)', async () => {
    // Same id+requestId written twice: a partial turn then the complete one.
    const root = await writeJsonl('stream.jsonl', [
      {
        type: 'assistant',
        timestamp: iso(NOW - 2000),
        requestId: 'req_s',
        message: { id: 'msg_s', model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 3 } }
      },
      {
        type: 'assistant',
        timestamp: iso(NOW - 1000),
        requestId: 'req_s',
        message: { id: 'msg_s', model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 1810 } }
      }
    ]);

    const records = await scanClaude({ root, sinceMs: NOW - DAY, untilMs: NOW });
    expect(records).toHaveLength(1);
    expect(records[0].outputTokens).toBe(1810);
  });

  it('excludes synthetic turns (matches ccusage)', async () => {
    const root = await writeJsonl('synthetic.jsonl', [
      {
        type: 'assistant',
        timestamp: iso(NOW - 1000),
        requestId: 'req_x',
        message: { id: 'msg_x', model: '<synthetic>', usage: { input_tokens: 5, output_tokens: 5 } }
      }
    ]);
    const records = await scanClaude({ root, sinceMs: NOW - DAY, untilMs: NOW });
    expect(records).toHaveLength(0);
  });
});

function codexCount(ts: number, input: number, cached: number, output: number, total: number): unknown {
  return {
    timestamp: iso(ts),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          total_tokens: total
        }
      }
    }
  };
}

describe('scanCodex', () => {
  it('diffs the cumulative total (not summing overlapping deltas), splitting cached input', async () => {
    const root = await writeJsonl('rollout.jsonl', [
      { timestamp: iso(NOW - 6000), type: 'turn_context', payload: { model: 'gpt-5.5' } },
      // cumulative snapshots: 1050 then 2120 — the increment is one turn's usage
      codexCount(NOW - 5000, 1000, 200, 50, 1050),
      codexCount(NOW - 4000, 2000, 400, 120, 2120)
    ]);

    const records = await scanCodex({ root, sinceMs: NOW - DAY, untilMs: NOW });
    // total tokens across records must equal the final cumulative (2120), never the sum of cumulatives
    const totalTokens = records.reduce(
      (sum, r) => sum + r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens,
      0
    );
    expect(totalTokens).toBe(2120);
    expect(records.every((r) => r.model === 'gpt-5.5')).toBe(true);
    // first increment: input 1000 / cached 200 / output 50  → uncached input 800, cacheRead 200
    expect(records[0]).toMatchObject({ inputTokens: 800, cacheReadTokens: 200, outputTokens: 50, cacheWriteTokens: 0 });
  });

  it('treats a cumulative drop as a context reset (counts the post-reset usage)', async () => {
    const root = await writeJsonl('reset.jsonl', [
      { timestamp: iso(NOW - 6000), type: 'turn_context', payload: { model: 'gpt-5.5' } },
      codexCount(NOW - 5000, 5000, 0, 100, 5100),
      // cumulative drops (compaction) — the new snapshot is counted in full
      codexCount(NOW - 4000, 800, 0, 30, 830)
    ]);

    const records = await scanCodex({ root, sinceMs: NOW - DAY, untilMs: NOW });
    const totalTokens = records.reduce(
      (sum, r) => sum + r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens,
      0
    );
    expect(totalTokens).toBe(5100 + 830);
  });

  it('maintains the cumulative baseline across the window edge (no inflated first increment)', async () => {
    const root = await writeJsonl('edge.jsonl', [
      { timestamp: iso(NOW - 2 * DAY - 1000), type: 'turn_context', payload: { model: 'gpt-5.5' } },
      // out of window: establishes baseline 1000 but is not emitted
      codexCount(NOW - 2 * DAY, 1000, 0, 0, 1000),
      // in window: cumulative 1500 → increment is only 500, not 1500
      codexCount(NOW - 1000, 1500, 0, 0, 1500)
    ]);

    const records = await scanCodex({ root, sinceMs: NOW - DAY, untilMs: NOW });
    const totalTokens = records.reduce((sum, r) => sum + r.inputTokens, 0);
    expect(totalTokens).toBe(500);
  });
});

describe('scanPi', () => {
  it('passes through the recorded cost, including zero', async () => {
    const root = await writeJsonl('pi.jsonl', [
      {
        type: 'message',
        timestamp: iso(NOW - 1000),
        message: {
          role: 'assistant',
          model: 'glm-5.1',
          usage: {
            input: 11349,
            output: 4,
            cacheRead: 1024,
            cacheWrite: 0,
            totalTokens: 12377,
            cost: { total: 0 }
          }
        }
      }
    ]);

    const records = await scanPi({ root, sinceMs: NOW - DAY, untilMs: NOW });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ source: 'pi', model: 'glm-5.1', costUsd: 0, inputTokens: 11349, cacheReadTokens: 1024 });
  });
});

describe('collectWindowUsage', () => {
  // Explicit source list so the run is hermetic (no reading the real ~/.claude,
  // ~/.gemini, ~/.local/share/opencode on the test machine). Roots are keyed by id.
  const claudeSource: BillableSource = { id: 'claude', scanUsage: scanClaude };
  const codexSource: BillableSource = { id: 'codex', scanUsage: scanCodex };
  const piSource: BillableSource = { id: 'pi', scanUsage: scanPi };

  it('aggregates across sources with per-source and total cost', async () => {
    await writeJsonl('claude.jsonl', [
      {
        type: 'assistant',
        timestamp: iso(NOW - 1000),
        requestId: 'r',
        message: { id: 'm', model: 'claude-opus-4-8', usage: { input_tokens: 1_000_000, output_tokens: 0 } }
      }
    ]);

    const window = await collectWindowUsage({
      days: 1,
      now: NOW,
      sources: [claudeSource, codexSource, piSource],
      roots: { claude: dir, codex: dir, pi: dir }
    });

    const claude = window.bySource.find((s) => s.source === 'claude');
    expect(claude?.inputTokens).toBe(1_000_000);
    expect(claude?.costUsd).toBeCloseTo(15, 5); // 1M input @ opus $15/MTok
    expect(window.total.costUsd).toBeCloseTo(15, 5);
    const startOfToday = new Date(NOW);
    startOfToday.setHours(0, 0, 0, 0);
    expect(window.sinceMs).toBe(startOfToday.getTime()); // calendar-day: snaps to local midnight
    expect(window.untilMs).toBe(NOW);
  });

  it('a 7-day window starts at local midnight six days before today', async () => {
    const window = await collectWindowUsage({
      days: 7,
      now: NOW,
      sources: [claudeSource, codexSource, piSource],
      roots: { claude: dir, codex: dir, pi: dir }
    });
    const startOfToday = new Date(NOW);
    startOfToday.setHours(0, 0, 0, 0);
    expect(window.sinceMs).toBe(startOfToday.getTime() - 6 * DAY);
    expect(window.untilMs).toBe(NOW);
  });

  it('iterates the given sources dynamically, in order, one row per source', async () => {
    const fakeA: BillableSource = {
      id: 'alpha',
      scanUsage: async () => [
        {
          source: 'alpha',
          model: 'x',
          timestamp: NOW - 1000,
          inputTokens: 3,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          costUsd: 1.5
        } satisfies UsageRecord
      ]
    };
    const fakeB: BillableSource = { id: 'beta', scanUsage: async () => [] };

    const window = await collectWindowUsage({ days: 1, now: NOW, sources: [fakeA, fakeB] });
    expect(window.bySource.map((s) => s.source)).toEqual(['alpha', 'beta']);
    expect(window.bySource[0]).toMatchObject({ entries: 1, inputTokens: 3, costUsd: 1.5 });
    expect(window.bySource[1]).toMatchObject({ entries: 0, totalTokens: 0 });
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
    const ok: BillableSource = {
      id: 'ok',
      scanUsage: async () => [
        {
          source: 'ok',
          model: 'y',
          timestamp: NOW - 1000,
          inputTokens: 7,
          outputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          costUsd: 0.25
        } satisfies UsageRecord
      ]
    };

    const window = await collectWindowUsage({ days: 1, now: NOW, sources: [boom, ok] });
    expect(window.bySource.map((s) => s.source)).toEqual(['boom', 'ok']);
    expect(window.bySource[0]).toMatchObject({ entries: 0, totalTokens: 0 });
    expect(window.bySource[1]).toMatchObject({ entries: 1, inputTokens: 7 });
    expect(window.total.inputTokens).toBe(7);
  });
});
