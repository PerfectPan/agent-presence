import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import { collectWindowUsage, type BillableSource, type PricingOverrides } from '../src/usage/index.js';
import type { ScanEnvironment, WindowUsage } from '../src/usage/types.js';

// Noon of the current local day: fixture timestamps and mtimes are placed
// relative to it, so every scan runs inside one calendar window (days: 1) and
// the quiet rule (mtime before now - 30 minutes) is controlled explicitly.
const NOW = new Date();
NOW.setHours(12, 0, 0, 0);
const NOW_MS = NOW.getTime();
const MINUTE = 60_000;
const QUIET_MS = NOW_MS - 31 * MINUTE;
const iso = (ms: number) => new Date(ms).toISOString();

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-presence-kit-scan-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The transcript-root variables point every scanned agent's home into the fixture directory. */
function homeEnv(variable: string): ScanEnvironment {
  return { [variable]: dir };
}

/** A fixture written now counts as an active source; quietened, its decode is final. */
async function writeTranscript(segments: string[], lines: unknown[], quiet = true): Promise<string> {
  const file = join(dir, ...segments);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  const at = new Date(quiet ? QUIET_MS : NOW_MS);
  await utimes(file, at, at);
  return file;
}

async function collect(
  sources: BillableSource[],
  env: ScanEnvironment,
  now = NOW_MS,
  pricing?: PricingOverrides
): Promise<WindowUsage> {
  return collectWindowUsage({ days: 1, now, sources, env, pricing });
}

function sourceRow(window: WindowUsage, id: string): WindowUsage['bySource'][number] {
  const row = window.bySource.find((entry) => entry.source === id);
  expect(row).toBeDefined();
  return row!;
}

// --- Claude Code ---------------------------------------------------------

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

function claudeAssistant(
  ts: number,
  requestId: string | null,
  messageId: string,
  model: string,
  usage: ClaudeUsage
): unknown {
  return {
    type: 'assistant',
    timestamp: iso(ts),
    ...(requestId === null ? {} : { requestId }),
    message: { id: messageId, model, usage }
  };
}

describe('kit scan: claude-code', () => {
  it('de-duplicates by request key across files, keeping the largest occurrence within one', async () => {
    await writeTranscript(
      ['projects', 'session-a.jsonl'],
      [
        // Streaming rewrite: the request's records grow; the largest occurrence wins.
        claudeAssistant(NOW_MS - 2000, 'req_s', 'msg_s', 'mystery-model', { input_tokens: 100, output_tokens: 3 }),
        claudeAssistant(NOW_MS - 1000, 'req_s', 'msg_s', 'mystery-model', { input_tokens: 100, output_tokens: 1810 })
      ]
    );
    // A resumed copy in another file repeats the request under a new message id:
    // the old `message.id:requestId` key counted it twice, the request key counts it once.
    await writeTranscript(
      ['projects', 'session-b.jsonl'],
      [claudeAssistant(NOW_MS - 500, 'req_s', 'msg_copy', 'mystery-model', { input_tokens: 100, output_tokens: 1810 })]
    );

    const window = await collect([{ id: 'claude', kitAgent: 'claude-code' }], homeEnv('CLAUDE_CONFIG_DIR'));
    expect(sourceRow(window, 'claude')).toMatchObject({ entries: 1, totalTokens: 1910 });
  });

  it('excludes synthetic turns and keeps the cache TTL breakdown authoritative', async () => {
    await writeTranscript(
      ['projects', 'session.jsonl'],
      [
        claudeAssistant(NOW_MS - 1000, null, 'msg_x', '<synthetic>', { input_tokens: 5, output_tokens: 5 }),
        claudeAssistant(NOW_MS - 900, 'req_cache', 'msg_cache', 'mystery-model', {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 99,
          cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3 },
          cache_read_input_tokens: 100
        })
      ]
    );

    const window = await collect([{ id: 'claude', kitAgent: 'claude-code' }], homeEnv('CLAUDE_CONFIG_DIR'), NOW_MS, {
      'mystery-model': { input: 2, output: 8, cacheWrite: 2.5, cacheWrite1h: 10, cacheRead: 0.2 }
    });
    // Kit input adds the cache counts back; the total stays the old four-bucket sum.
    expect(sourceRow(window, 'claude')).toMatchObject({
      entries: 1,
      inputTokens: 115,
      outputTokens: 20,
      cacheWriteTokens: 5,
      cacheReadTokens: 100,
      totalTokens: 135
    });
    // (10*2 + 20*8 + (5-3)*2.5 + 3*10 + 100*0.2) / 1e6 — the one-hour subset at its dedicated rate.
    expect(sourceRow(window, 'claude').costUsd).toBeCloseTo(0.000235, 10);
  });

  it('counts only the reported token counts of a record (absent stays absent)', async () => {
    await writeTranscript(
      ['projects', 'session.jsonl'],
      [
        claudeAssistant(NOW_MS - 1000, 'req_partial', 'msg_p', 'mystery-model', { output_tokens: 50 }),
        // A record with no usage at all opens no request.
        claudeAssistant(NOW_MS - 900, 'req_empty', 'msg_e', 'mystery-model', {})
      ]
    );

    const window = await collect([{ id: 'claude', kitAgent: 'claude-code' }], homeEnv('CLAUDE_CONFIG_DIR'));
    expect(sourceRow(window, 'claude')).toMatchObject({ entries: 1, inputTokens: 0, outputTokens: 50 });
  });

  it("withholds an active source's open requests until four newer ones or the quiet final", async () => {
    const requests = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        claudeAssistant(NOW_MS - 5000 + index, `req_${index}`, `msg_${index}`, 'mystery-model', {
          input_tokens: 100 + index,
          output_tokens: 1
        })
      );
    const activeFile = await writeTranscript(['projects', 'active.jsonl'], requests(2), false);
    const env = homeEnv('CLAUDE_CONFIG_DIR');
    const claude: BillableSource = { id: 'claude', kitAgent: 'claude-code' };

    // An active source: two open requests stay withheld (a lane keeps up to four open).
    expect(sourceRow(await collect([claude], env), 'claude')).toMatchObject({ entries: 0 });

    // The same window after the source went quiet: the decode is final and reports both.
    await utimes(activeFile, new Date(QUIET_MS), new Date(QUIET_MS));
    expect(sourceRow(await collect([claude], env), 'claude')).toMatchObject({ entries: 2, totalTokens: 203 });

    // A fifth request in one lane releases the oldest before any quiet period.
    await rm(join(dir, 'projects', 'active.jsonl'), { force: true });
    await writeTranscript(['projects', 'lane.jsonl'], requests(5), false);
    expect(sourceRow(await collect([claude], env), 'claude')).toMatchObject({ entries: 1, totalTokens: 101 });
  });
});

// --- Codex ---------------------------------------------------------------

function codexTokenCount(
  ts: number,
  total: { input: number; cached: number; output: number; all: number },
  last?: { input: number; cached: number; output: number; all: number }
): unknown {
  return {
    timestamp: iso(ts),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: total.input,
          cached_input_tokens: total.cached,
          output_tokens: total.output,
          total_tokens: total.all
        },
        ...(last
          ? {
              last_token_usage: {
                input_tokens: last.input,
                cached_input_tokens: last.cached,
                output_tokens: last.output,
                total_tokens: last.all
              }
            }
          : {})
      }
    }
  };
}

const CODEX_PRICING = { 'gpt-5.6-sol': { input: 1, output: 2, cacheWrite: 0, cacheRead: 0 } };

describe('kit scan: codex', () => {
  it("reads each record's own service tier and switches to token_usage_record at its first sight", async () => {
    await writeTranscript(
      ['sessions', 'rollout-tier.jsonl'],
      [
        { timestamp: iso(NOW_MS - 6000), type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
        {
          timestamp: iso(NOW_MS - 5900),
          type: 'event_msg',
          payload: { type: 'thread_settings_applied', thread_settings: { service_tier: 'priority' } }
        },
        codexTokenCount(NOW_MS - 5000, { input: 100, cached: 0, output: 10, all: 110 }),
        {
          timestamp: iso(NOW_MS - 4900),
          type: 'event_msg',
          payload: { type: 'thread_settings_applied', thread_settings: { service_tier: 'standard' } }
        },
        codexTokenCount(
          NOW_MS - 4000,
          { input: 200, cached: 0, output: 20, all: 220 },
          { input: 100, cached: 0, output: 10, all: 110 }
        ),
        // From the first token_usage_record on, unchanged token_count totals are skipped.
        {
          timestamp: iso(NOW_MS - 3000),
          type: 'token_usage_record',
          payload: {
            response_id: 'resp_1',
            usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 5, total_tokens: 55 }
          }
        },
        codexTokenCount(NOW_MS - 2000, { input: 200, cached: 0, output: 20, all: 220 })
      ]
    );

    const window = await collect([{ id: 'codex', kitAgent: 'codex' }], homeEnv('CODEX_HOME'), NOW_MS, CODEX_PRICING);
    // Records: 110 (priority, ×2) + 110 (standard) + 55 (token_usage_record); the trailing
    // unchanged token_count is skipped. The old scanner applied one tier to every record
    // from ~/.codex/config.toml and never read token_usage_record.
    expect(sourceRow(window, 'codex')).toMatchObject({ entries: 3, totalTokens: 275 });
    expect(sourceRow(window, 'codex').costUsd).toBeCloseTo(420e-6, 10);
  });

  it('counts a trailing request as soon as its record is complete', async () => {
    await writeTranscript(
      ['sessions', 'rollout-fresh.jsonl'],
      [
        { timestamp: iso(NOW_MS - 1000), type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
        codexTokenCount(
          NOW_MS - 1000,
          { input: 30, cached: 0, output: 5, all: 35 },
          { input: 30, cached: 0, output: 5, all: 35 }
        )
      ],
      false
    );

    const window = await collect([{ id: 'codex', kitAgent: 'codex' }], homeEnv('CODEX_HOME'));
    expect(sourceRow(window, 'codex')).toMatchObject({ entries: 1, totalTokens: 35 });
  });
});

// --- Gemini CLI ----------------------------------------------------------

function geminiMessage(id: string, ts: number, tokens: Record<string, number> | null): unknown {
  const record: Record<string, unknown> = {
    id,
    timestamp: iso(ts),
    type: 'gemini',
    model: 'mystery-model',
    content: []
  };
  if (tokens) {
    record.tokens = tokens;
  }
  return record;
}

describe('kit scan: gemini-cli', () => {
  it('counts a migrated chat once from its .jsonl file and adds tool tokens to the input', async () => {
    const migrated = geminiMessage('g1', NOW_MS - 1000, { input: 100, output: 20, cached: 30, thoughts: 5, tool: 7 });
    await writeTranscript(
      ['.gemini', 'tmp', 'proj', 'chats', 'session.jsonl'],
      [{ sessionId: 's1', projectHash: 'proj' }, migrated]
    );
    // The legacy chat the .jsonl was migrated from carries a larger copy of the same message.
    const legacy = join(dir, '.gemini', 'tmp', 'proj', 'chats', 'session.json');
    await writeFile(
      legacy,
      JSON.stringify({
        sessionId: 's1',
        messages: [geminiMessage('g1', NOW_MS - 2000, { input: 900, output: 900 })]
      }),
      'utf8'
    );
    await utimes(legacy, new Date(QUIET_MS), new Date(QUIET_MS));

    const window = await collect([{ id: 'gemini', kitAgent: 'gemini-cli' }], homeEnv('GEMINI_CLI_HOME'));
    // Only the .jsonl file is a source: kit input = input + tool = 107, output = 20 + 5 thoughts.
    expect(sourceRow(window, 'gemini')).toMatchObject({
      entries: 1,
      inputTokens: 107,
      outputTokens: 25,
      cacheReadTokens: 30,
      totalTokens: 132
    });
  });

  it('reads chats under $GEMINI_CLI_HOME/.gemini/tmp, not $GEMINI_CLI_HOME/tmp', async () => {
    await writeTranscript(
      ['.gemini', 'tmp', 'proj', 'chats', 'new.jsonl'],
      [geminiMessage('g_new', NOW_MS - 1000, { input: 10, output: 2 })]
    );
    await writeTranscript(
      ['tmp', 'proj', 'chats', 'old.jsonl'],
      [geminiMessage('g_old', NOW_MS - 1000, { input: 999, output: 999 })]
    );

    const window = await collect([{ id: 'gemini', kitAgent: 'gemini-cli' }], homeEnv('GEMINI_CLI_HOME'));
    expect(sourceRow(window, 'gemini')).toMatchObject({ entries: 1, totalTokens: 12 });
  });

  it('counts a trailing message as soon as its record is complete', async () => {
    await writeTranscript(
      ['.gemini', 'tmp', 'proj', 'chats', 'fresh.jsonl'],
      [geminiMessage('g_fresh', NOW_MS - 1000, { input: 10, output: 2 })],
      false
    );

    const window = await collect([{ id: 'gemini', kitAgent: 'gemini-cli' }], homeEnv('GEMINI_CLI_HOME'));
    expect(sourceRow(window, 'gemini')).toMatchObject({ entries: 1, totalTokens: 12 });
  });
});

// --- Pi ------------------------------------------------------------------

function piMessage(id: string, ts: number, input: number, output: number, cost: number): unknown {
  return {
    id,
    type: 'message',
    timestamp: iso(ts),
    message: {
      role: 'assistant',
      model: 'mystery-model',
      usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { total: cost } }
    }
  };
}

describe('kit scan: pi', () => {
  it('skips the copied parent entries of a forked session and trusts the logged cost, even zero', async () => {
    const forkAt = NOW_MS - 10_000;
    await writeTranscript(
      ['sessions', 'child.jsonl'],
      [
        { type: 'session', id: 'child', parentSession: 'parent', timestamp: iso(forkAt) },
        piMessage('e1', forkAt - 1000, 10, 2, 0.01), // copied from the parent: skipped
        piMessage('e2', forkAt + 1000, 20, 4, 0) // the session's own turn: counted, zero cost kept
      ]
    );

    const window = await collect([{ id: 'pi', kitAgent: 'pi' }], homeEnv('PI_CODING_AGENT_DIR'));
    expect(sourceRow(window, 'pi')).toMatchObject({ entries: 1, totalTokens: 24, costUsd: 0 });
  });

  it('counts a trailing message as soon as its record is complete', async () => {
    await writeTranscript(['sessions', 'fresh.jsonl'], [piMessage('e1', NOW_MS - 1000, 7, 3, 1)], false);

    const window = await collect([{ id: 'pi', kitAgent: 'pi' }], homeEnv('PI_CODING_AGENT_DIR'));
    expect(sourceRow(window, 'pi')).toMatchObject({ entries: 1, totalTokens: 10 });
  });
});

// --- opencode ------------------------------------------------------------

interface OpenCodeMessage {
  createdMs: number;
  completedMs?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
}

function opencodeData(message: OpenCodeMessage): string {
  return JSON.stringify({
    id: 'msg_1',
    role: 'assistant',
    modelID: 'mystery-model',
    cost: message.cost ?? 0,
    tokens: {
      input: message.input ?? 0,
      output: message.output ?? 0,
      reasoning: message.reasoning ?? 0,
      cache: { read: message.cacheRead ?? 0, write: message.cacheWrite ?? 0 },
      total: 0
    },
    time: {
      created: message.createdMs,
      ...(message.completedMs === undefined ? {} : { completed: message.completedMs })
    }
  });
}

function writeOpencodeDb(rows: Array<{ id: string; createdMs: number; data: string }>): void {
  mkdirSync(dirname(join(dir, 'opencode', 'opencode.db')), { recursive: true });
  const db = new DatabaseSync(join(dir, 'opencode', 'opencode.db'), { readOnly: false });
  db.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
  const insert = db.prepare(
    'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
  );
  for (const row of rows) {
    insert.run(row.id, 'ses_1', row.createdMs, row.createdMs, row.data);
  }
  db.close();
}

describe('kit scan: opencode', () => {
  it('counts completed database messages, folds reasoning into output, and keeps the logged cost', async () => {
    writeOpencodeDb([
      {
        id: 'msg_1',
        createdMs: NOW_MS - 2000,
        data: opencodeData({
          createdMs: NOW_MS - 2000,
          completedMs: NOW_MS - 1000,
          input: 480,
          output: 464,
          reasoning: 2030,
          cacheRead: 79488,
          cost: 0.02104008
        })
      }
    ]);

    const window = await collect([{ id: 'opencode', kitAgent: 'opencode' }], homeEnv('XDG_DATA_HOME'));
    // Kit input adds the cache back (480 + 79488), output folds reasoning (464 + 2030):
    // the badge total stays opencode's own 82462.
    expect(sourceRow(window, 'opencode')).toMatchObject({
      entries: 1,
      totalTokens: 82_462,
      costUsd: 0.02104008
    });
  });

  it('withholds a running message until the database goes quiet, then counts it at its creation', async () => {
    const dbPath = join(dir, 'opencode', 'opencode.db');
    writeOpencodeDb([
      { id: 'msg_run', createdMs: NOW_MS - 2000, data: opencodeData({ createdMs: NOW_MS - 2000, input: 5 }) }
    ]);
    const env = homeEnv('XDG_DATA_HOME');
    const opencode: BillableSource = { id: 'opencode', kitAgent: 'opencode' };

    expect(sourceRow(await collect([opencode], env), 'opencode')).toMatchObject({ entries: 0 });

    await utimes(dbPath, new Date(QUIET_MS), new Date(QUIET_MS));
    expect(sourceRow(await collect([opencode], env), 'opencode')).toMatchObject({ entries: 1, totalTokens: 5 });
  });

  it('reports nothing for an unreadable database instead of falling back to the legacy JSON store', async () => {
    // A database exists but is not readable as one; a legacy JSON store sits next to it.
    await mkdir(join(dir, 'opencode', 'storage', 'message', 'ses_legacy'), { recursive: true });
    await writeFile(join(dir, 'opencode', 'opencode.db'), 'this is not a database', 'utf8');
    await writeFile(
      join(dir, 'opencode', 'storage', 'message', 'ses_legacy', 'msg_a.json'),
      opencodeData({ createdMs: NOW_MS - 1000, completedMs: NOW_MS - 1000, input: 100, cost: 0.01 }),
      'utf8'
    );

    const window = await collect([{ id: 'opencode', kitAgent: 'opencode' }], homeEnv('XDG_DATA_HOME'));
    // The old scanner fell back to the legacy store; the kit reports a source failure.
    expect(sourceRow(window, 'opencode')).toMatchObject({ entries: 0, totalTokens: 0, costUsd: null });
  });
});

// --- Grok ----------------------------------------------------------------

describe('kit scan: grok', () => {
  it('counts a completed turn with its per-model usage and logged tick cost', async () => {
    await writeTranscript(
      ['sessions', 'ses1', 'updates.jsonl'],
      [
        {
          timestamp: iso(NOW_MS - 1000),
          params: {
            update: {
              sessionUpdate: 'turn_completed',
              prompt_id: 'p1',
              schema_version: 1,
              usage: {
                inputTokens: 100,
                outputTokens: 20,
                totalTokens: 120,
                cachedReadTokens: 30,
                cacheCreationTokens: 0,
                reasoningTokens: 5,
                modelCalls: 2,
                costUsdTicks: 126_890_500
              }
            }
          }
        }
      ]
    );

    const window = await collect([{ id: 'grok', kitAgent: 'grok' }], homeEnv('GROK_HOME'));
    expect(sourceRow(window, 'grok')).toMatchObject({
      entries: 1,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      totalTokens: 120,
      costUsd: 0.01268905
    });
  });
});

// --- source table mapping ---------------------------------------------------

describe('kit scan source mapping', () => {
  it('maps the built-in table entry to its kit agent id and scans its transcripts', async () => {
    const { billableSources } = await import('../src/usage/billable-sources.js');
    const claude = (await billableSources({})).find((entry) => entry.id === 'claude');
    expect(claude?.kitAgent).toBe('claude-code');
    if (claude?.kitAgent === undefined) {
      throw new Error('claude must be kit-backed');
    }

    await writeTranscript(
      ['projects', 'session.jsonl'],
      [claudeAssistant(NOW_MS - 1000, 'req_1', 'msg_1', 'mystery-model', { input_tokens: 10, output_tokens: 2 })]
    );
    const window = await collect([claude], homeEnv('CLAUDE_CONFIG_DIR'));
    expect(sourceRow(window, 'claude')).toMatchObject({ entries: 1, totalTokens: 12 });
  });
});

// --- shared scan behavior --------------------------------------------------

describe('kit scan window', () => {
  it('scans two table entries that resolve to one built-in through the one batched call, reporting both', async () => {
    await writeTranscript(
      ['projects', 'session.jsonl'],
      [claudeAssistant(NOW_MS - 1000, 'req_1', 'msg_1', 'mystery-model', { input_tokens: 10, output_tokens: 5 })]
    );
    await writeTranscript(
      ['.gemini', 'tmp', 'proj', 'chats', 'session.jsonl'],
      [geminiMessage('g1', NOW_MS - 1000, { input: 10, output: 2 })]
    );
    const handler: BillableSource = {
      id: 'custom',
      scanUsage: async () => [
        {
          source: 'custom',
          model: 'mystery-model',
          timestamp: NOW_MS - 1000,
          inputTokens: 3,
          outputTokens: 1,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          costUsd: null
        }
      ]
    };

    const window = await collect(
      [
        { id: 'claude', kitAgent: 'claude-code' },
        { id: 'gemini', kitAgent: 'gemini-cli' },
        // A configured entry reusing a built-in scans the same decoder; both
        // entries report the built-in's contribution, as the per-entry scans did.
        { id: 'work', kitAgent: 'claude-code' },
        handler
      ],
      { ...homeEnv('CLAUDE_CONFIG_DIR'), ...homeEnv('GEMINI_CLI_HOME') }
    );

    expect(window.bySource.map((entry) => entry.source)).toEqual(['claude', 'gemini', 'work', 'custom']);
    expect(sourceRow(window, 'claude')).toMatchObject({ entries: 1, totalTokens: 15 });
    expect(sourceRow(window, 'work')).toMatchObject({ entries: 1, totalTokens: 15 });
    expect(sourceRow(window, 'gemini')).toMatchObject({ entries: 1, totalTokens: 12 });
    expect(sourceRow(window, 'custom')).toMatchObject({ entries: 1, totalTokens: 4 });
    expect(window.total.totalTokens).toBe(46);
  });

  it('gives identical snapshots for two scans of one window (stateless, no scan state)', async () => {
    await writeTranscript(
      ['.gemini', 'tmp', 'proj', 'chats', 'session.jsonl'],
      [geminiMessage('g1', NOW_MS - 1000, { input: 10, output: 2 })]
    );
    const env = homeEnv('GEMINI_CLI_HOME');
    const sources: BillableSource[] = [{ id: 'gemini', kitAgent: 'gemini-cli' }];

    const first = await collect(sources, env);
    const second = await collect(sources, env);
    expect(second).toEqual(first);
  });

  it("rolls over at midnight: each local day's window reads only its own range", async () => {
    const todayNoon = NOW_MS;
    const yesterdayEvening = todayNoon - 13 * 60 * 60 * 1000; // ~23:00 yesterday
    const todayEarly = todayNoon - 11 * 60 * 60 * 1000; // ~01:00 today
    await writeTranscript(
      ['.gemini', 'tmp', 'proj', 'chats', 'session.jsonl'],
      [
        geminiMessage('g_yesterday', yesterdayEvening, { input: 10, output: 1 }),
        geminiMessage('g_today', todayEarly, { input: 20, output: 2 })
      ]
    );
    const env = homeEnv('GEMINI_CLI_HOME');
    const sources: BillableSource[] = [{ id: 'gemini', kitAgent: 'gemini-cli' }];

    const beforeMidnight = await collect(sources, env, yesterdayEvening + 30 * MINUTE);
    expect(sourceRow(beforeMidnight, 'gemini')).toMatchObject({ entries: 1, totalTokens: 11 });

    const afterMidnight = await collect(sources, env, todayNoon);
    expect(sourceRow(afterMidnight, 'gemini')).toMatchObject({ entries: 1, totalTokens: 22 });
  });

  it('applies a price change on the next scan of the same window', async () => {
    await writeTranscript(
      ['projects', 'session.jsonl'],
      [claudeAssistant(NOW_MS - 1000, 'req_1', 'msg_1', 'mystery-model', { input_tokens: 1_000_000, output_tokens: 0 })]
    );
    const env = homeEnv('CLAUDE_CONFIG_DIR');
    const sources: BillableSource[] = [{ id: 'claude', kitAgent: 'claude-code' }];

    const before = await collect(sources, env, NOW_MS, {
      'mystery-model': { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 }
    });
    const after = await collect(sources, env, NOW_MS, {
      'mystery-model': { input: 9, output: 1, cacheWrite: 0, cacheRead: 0 }
    });
    expect(sourceRow(before, 'claude').costUsd).toBeCloseTo(1, 8);
    expect(sourceRow(after, 'claude').costUsd).toBeCloseTo(9, 8);
  });
});
