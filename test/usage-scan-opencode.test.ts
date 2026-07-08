import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scanOpenCode } from '../src/usage/scan-opencode.js';

// Real "now" so freshly-written fixtures pass any mtime pre-filter; window math
// is relative, so token assertions stay deterministic.
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-presence-opencode-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface AssistantMessage {
  createdMs: number;
  completedMs?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
  modelID?: string;
}

function assistantData(message: AssistantMessage): string {
  return JSON.stringify({
    role: 'assistant',
    modelID: message.modelID ?? 'deepseek-v4-pro',
    providerID: 'deepseek',
    cost: message.cost ?? 0,
    tokens: {
      input: message.input ?? 0,
      output: message.output ?? 0,
      reasoning: message.reasoning ?? 0,
      cache: { read: message.cacheRead ?? 0, write: message.cacheWrite ?? 0 },
      total:
        (message.input ?? 0) +
        (message.output ?? 0) +
        (message.reasoning ?? 0) +
        (message.cacheRead ?? 0) +
        (message.cacheWrite ?? 0)
    },
    time: { created: message.createdMs, completed: message.completedMs ?? message.createdMs }
  });
}

/** Build a minimal opencode SQLite store with a `message` table. */
function writeDb(rows: Array<{ id: string; createdMs: number; data: string }>): string {
  const db = new DatabaseSync(join(dir, 'opencode.db'));
  db.exec(
    'CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)'
  );
  const insert = db.prepare(
    'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
  );
  for (const row of rows) {
    insert.run(row.id, 'ses_1', row.createdMs, row.createdMs, row.data);
  }
  db.close();
  return dir;
}

describe('scanOpenCode (SQLite)', () => {
  it('extracts assistant usage, folds reasoning into output, splits cache, and trusts logged cost', async () => {
    const root = writeDb([
      {
        id: 'msg_1',
        createdMs: NOW - 1000,
        data: assistantData({
          createdMs: NOW - 2000,
          completedMs: NOW - 1000,
          input: 480,
          output: 464,
          reasoning: 2030,
          cacheRead: 79488,
          cacheWrite: 0,
          cost: 0.02104008
        })
      },
      // A user message must be ignored.
      { id: 'msg_u', createdMs: NOW - 900, data: JSON.stringify({ role: 'user' }) }
    ]);

    const records = await scanOpenCode({ root, sinceMs: NOW - DAY, untilMs: NOW });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      source: 'opencode',
      model: 'deepseek-v4-pro',
      inputTokens: 480,
      outputTokens: 464 + 2030, // reasoning folds into output
      cacheReadTokens: 79488,
      cacheWriteTokens: 0,
      costUsd: 0.02104008
    });
    // Four buckets reproduce opencode's own total.
    const r = records[0];
    expect(r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens).toBe(82462);
  });

  it('keeps a zero cost (trusted, not repriced)', async () => {
    const root = writeDb([
      { id: 'msg_z', createdMs: NOW - 1000, data: assistantData({ createdMs: NOW - 1000, input: 10, cost: 0 }) }
    ]);
    const records = await scanOpenCode({ root, sinceMs: NOW - DAY, untilMs: NOW });
    expect(records).toHaveLength(1);
    expect(records[0].costUsd).toBe(0);
  });

  it('filters by the message completion time against the window', async () => {
    const root = writeDb([
      // completed inside the window
      { id: 'in', createdMs: NOW - 2000, data: assistantData({ createdMs: NOW - 2000, completedMs: NOW - 1000, input: 5 }) },
      // completed before the window (but created recently) — dropped
      {
        id: 'old',
        createdMs: NOW - 1500,
        data: assistantData({ createdMs: NOW - 3 * DAY, completedMs: NOW - 3 * DAY, input: 999 })
      }
    ]);
    const records = await scanOpenCode({ root, sinceMs: NOW - DAY, untilMs: NOW });
    expect(records).toHaveLength(1);
    expect(records[0].inputTokens).toBe(5);
  });

  it('returns [] for a missing store', async () => {
    const records = await scanOpenCode({ root: join(dir, 'nonexistent'), sinceMs: NOW - DAY, untilMs: NOW });
    expect(records).toEqual([]);
  });
});

describe('scanOpenCode (legacy JSON fallback)', () => {
  it('reads storage/message/{session}/*.json when no DB is present', async () => {
    const sessionDir = join(dir, 'storage', 'message', 'ses_legacy');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'msg_a.json'),
      assistantData({ createdMs: NOW - 1000, input: 100, output: 20, reasoning: 5, cacheRead: 50, cost: 0.01 }),
      'utf8'
    );
    // A non-assistant file is ignored.
    await writeFile(join(sessionDir, 'msg_b.json'), JSON.stringify({ role: 'user' }), 'utf8');

    const records = await scanOpenCode({ root: dir, sinceMs: NOW - DAY, untilMs: NOW });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      source: 'opencode',
      inputTokens: 100,
      outputTokens: 25, // 20 + 5 reasoning
      cacheReadTokens: 50,
      costUsd: 0.01
    });
  });
});
