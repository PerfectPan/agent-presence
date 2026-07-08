import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scanGemini } from '../src/usage/scan-gemini.js';

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-presence-gemini-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface GeminiTokens {
  input?: number;
  output?: number;
  cached?: number;
  thoughts?: number;
  tool?: number;
}

function geminiMessage(id: string, tsMs: number, tokens: GeminiTokens | null, model = 'gemini-3-pro'): unknown {
  const record: Record<string, unknown> = { id, timestamp: iso(tsMs), type: 'gemini', model, content: [] };
  if (tokens) {
    record.tokens = {
      input: tokens.input ?? 0,
      output: tokens.output ?? 0,
      cached: tokens.cached ?? 0,
      thoughts: tokens.thoughts ?? 0,
      tool: tokens.tool ?? 0,
      total:
        (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.thoughts ?? 0) + (tokens.tool ?? 0)
    };
  }
  return record;
}

/** Write a JSONL chat file under a project-hash/chats dir, like the CLI does. */
async function writeChatJsonl(name: string, lines: unknown[]): Promise<string> {
  const chatsDir = join(dir, 'projhash', 'chats');
  await mkdir(chatsDir, { recursive: true });
  await writeFile(join(chatsDir, name), lines.map((line) => JSON.stringify(line)).join('\n'), 'utf8');
  return dir;
}

describe('scanGemini (JSONL)', () => {
  it('extracts gemini turns, splits cached from input, folds thoughts into output, reprices (costUsd null)', async () => {
    const root = await writeChatJsonl('session-2026-01-01-abcd1234.jsonl', [
      // metadata line — ignored
      { sessionId: 's1', projectHash: 'projhash', startTime: iso(NOW - 5000), lastUpdated: iso(NOW - 1000) },
      // user message — ignored
      { id: 'u1', timestamp: iso(NOW - 2000), type: 'user', content: 'hi' },
      geminiMessage('g1', NOW - 1000, { input: 1000, output: 200, cached: 300, thoughts: 50 })
    ]);

    const records = await scanGemini({ root, sinceMs: NOW - DAY, untilMs: NOW });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      source: 'gemini',
      model: 'gemini-3-pro',
      inputTokens: 700, // 1000 - 300 cached
      cacheReadTokens: 300,
      outputTokens: 250, // 200 + 50 thoughts
      cacheWriteTokens: 0,
      costUsd: null // no cost logged; repriced via table (no gemini default → n/a)
    });
  });

  it('de-duplicates by message id, keeping the largest-total (token-bearing) occurrence', async () => {
    // The CLI re-appends the same id once tokens are attached.
    const root = await writeChatJsonl('session.jsonl', [
      geminiMessage('g1', NOW - 2000, null), // pre-token copy
      geminiMessage('g1', NOW - 1000, { input: 500, output: 120 }) // token-bearing copy
    ]);

    const records = await scanGemini({ root, sinceMs: NOW - DAY, untilMs: NOW });
    expect(records).toHaveLength(1);
    expect(records[0].inputTokens).toBe(500);
    expect(records[0].outputTokens).toBe(120);
  });

  it('drops turns outside the window', async () => {
    const root = await writeChatJsonl('session.jsonl', [
      geminiMessage('old', NOW - 3 * DAY, { input: 999, output: 999 }),
      geminiMessage('new', NOW - 1000, { input: 10, output: 20 })
    ]);
    const records = await scanGemini({ root, sinceMs: NOW - DAY, untilMs: NOW });
    expect(records).toHaveLength(1);
    expect(records[0].inputTokens).toBe(10);
  });

  it('ignores gemini messages without a tokens object', async () => {
    const root = await writeChatJsonl('session.jsonl', [geminiMessage('g1', NOW - 1000, null)]);
    const records = await scanGemini({ root, sinceMs: NOW - DAY, untilMs: NOW });
    expect(records).toHaveLength(0);
  });
});

describe('scanGemini (legacy single-object JSON)', () => {
  it('reads the messages[] array from a legacy .json session', async () => {
    const chatsDir = join(dir, 'projhash', 'chats');
    await mkdir(chatsDir, { recursive: true });
    await writeFile(
      join(chatsDir, 'legacy.json'),
      JSON.stringify({
        sessionId: 's-legacy',
        projectHash: 'projhash',
        messages: [
          { id: 'u', timestamp: iso(NOW - 2000), type: 'user', content: 'hi' },
          geminiMessage('g', NOW - 1000, { input: 400, output: 60, cached: 100 })
        ]
      }),
      'utf8'
    );

    const records = await scanGemini({ root: dir, sinceMs: NOW - DAY, untilMs: NOW });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ inputTokens: 300, cacheReadTokens: 100, outputTokens: 60 });
  });
});
