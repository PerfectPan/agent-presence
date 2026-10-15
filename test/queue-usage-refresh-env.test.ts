import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { DatabaseSync } from 'node:sqlite';

import { loadConfig } from '../src/config.js';
import { applyQueueBatch } from '../src/queue/apply.js';
import { defaultOwedWorkEffects, knownSources, workOffOwedItem } from '../src/queue/follow-up.js';
import { doableOwedItems } from '../src/queue/owed.js';
import { createQueueHome, eventBody, recordAt, readState, T0, type QueueHome } from './queue-support.js';

// The worker's usage refresh scans with the recorded agent-home variables: a
// value the hook's environment carried reaches the scan through the entry's
// `scanEnv` and decides where it reads; a value only the worker's environment
// has is not read — an agent whose variable was not recorded reads its default
// root under the refresh's home instead. Real fixtures and the real scan; no
// module mocks.

const MINUTE = 60_000;
const QUIET = T0 - 31 * MINUTE;
const iso = (ms: number) => new Date(ms).toISOString();

const AGENTS: Array<{ source: string; variable: string }> = [
  { source: 'claude', variable: 'CLAUDE_CONFIG_DIR' },
  { source: 'codex', variable: 'CODEX_HOME' },
  { source: 'gemini', variable: 'GEMINI_CLI_HOME' },
  { source: 'grok', variable: 'GROK_HOME' },
  { source: 'opencode', variable: 'XDG_DATA_HOME' },
  { source: 'pi', variable: 'PI_CODING_AGENT_DIR' }
];

/** One transcript worth `tokens` (100 by default) under `root`, laid out as the agent keeps it. */
async function writeFixture(root: string, agent: string, tokens = 100): Promise<void> {
  const write = async (segments: string[], content: string, quiet: boolean): Promise<void> => {
    const file = join(root, ...segments);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
    const at = new Date(quiet ? QUIET : T0 - 1000);
    await utimes(file, at, at);
  };

  if (agent === 'claude') {
    await write(
      ['projects', 'session.jsonl'],
      `${JSON.stringify({
        type: 'assistant',
        timestamp: iso(T0 - 1000),
        requestId: 'req_env',
        message: {
          id: 'msg_env',
          model: 'mystery-model',
          usage: { input_tokens: tokens - 10, output_tokens: 10 }
        }
      })}\n`,
      true
    );
  } else if (agent === 'codex') {
    await write(
      ['sessions', 'rollout-env.jsonl'],
      `${JSON.stringify({
        timestamp: iso(T0 - 1000),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: tokens - 20,
              cached_input_tokens: 0,
              output_tokens: 20,
              total_tokens: tokens
            },
            last_token_usage: {
              input_tokens: tokens - 20,
              cached_input_tokens: 0,
              output_tokens: 20,
              total_tokens: tokens
            }
          }
        }
      })}\n`,
      false
    );
  } else if (agent === 'gemini') {
    await write(
      ['.gemini', 'tmp', 'p', 'chats', 'session.jsonl'],
      `${JSON.stringify({
        id: 'g_env',
        timestamp: iso(T0 - 1000),
        type: 'gemini',
        model: 'mystery-model',
        tokens: { input: tokens - 40, output: 40 }
      })}\n`,
      false
    );
  } else if (agent === 'grok') {
    await write(
      ['sessions', 'ses_env', 'updates.jsonl'],
      `${JSON.stringify({
        timestamp: iso(T0 - 1000),
        params: {
          update: {
            sessionUpdate: 'turn_completed',
            prompt_id: 'p_env',
            schema_version: 1,
            usage: { inputTokens: tokens - 30, outputTokens: 30, totalTokens: tokens }
          }
        }
      })}\n`,
      false
    );
  } else if (agent === 'opencode') {
    const dbPath = join(root, 'opencode', 'opencode.db');
    await mkdir(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
    db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
      'msg_env',
      'ses_env',
      T0 - 1000,
      T0 - 1000,
      JSON.stringify({
        role: 'assistant',
        modelID: 'mystery-model',
        cost: 0,
        tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 100 },
        time: { created: T0 - 1000, completed: T0 - 1000 }
      })
    );
    db.close();
    const at = new Date(T0 - 1000);
    await utimes(dbPath, at, at);
  } else {
    await write(
      ['sessions', 'session.jsonl'],
      `${JSON.stringify({
        id: 'e_env',
        type: 'message',
        timestamp: iso(T0 - 1000),
        message: {
          role: 'assistant',
          model: 'mystery-model',
          usage: { input: tokens - 30, output: 30, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }
        }
      })}\n`,
      false
    );
  }
}

let home: QueueHome;
// The refresh's own home: the kit's default roots (`os.homedir()/.claude`, ...)
// resolve here, so no scan of this file walks the developer's real home,
// whatever HOME the outer run has.
let defaultHome: string;

const savedEnv = new Map<string, string | undefined>(
  [
    'HOME',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'GEMINI_CLI_HOME',
    'GROK_HOME',
    'XDG_DATA_HOME',
    'PI_CODING_AGENT_DIR'
  ].map((name) => [name, process.env[name]])
);

beforeEach(async () => {
  home = await createQueueHome();
  defaultHome = await mkdtemp(join(tmpdir(), 'env-default-home-'));
  process.env.HOME = defaultHome;
  // The worker's environment points every agent at its worker-home, each
  // holding a real 100-token fixture; only a recorded variable may lead the
  // scan there.
  for (const agent of AGENTS) {
    const workerDir = join(defaultHome, 'worker-env', agent.source);
    await writeFixture(workerDir, agent.source);
    process.env[agent.variable] = workerDir;
  }
});

afterEach(async () => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  await rm(defaultHome, { recursive: true, force: true });
  await home.dispose();
});

async function refreshWithRecorded(scanEnv: Record<string, string>, source: string): Promise<void> {
  await recordAt(home.statePath, T0, eventBody('SessionStart', 's_env', { source, scanEnv }));
  await applyQueueBatch(home.statePath, {
    version: 1,
    config: await loadConfig(),
    clock: { now: () => T0 + 1000 }
  });
  const state = await readState(home.statePath);
  const item = doableOwedItems(state.queueOwed, knownSources(await loadConfig())).find(
    (candidate) => candidate.kind === 'usageRefresh' && candidate.entry.source === source
  );
  if (!item) {
    throw new Error(`no owed usageRefresh for ${source}`);
  }
  const outcome = await workOffOwedItem(item, {
    statePath: home.statePath,
    config: await loadConfig(),
    clock: { now: () => T0 + 2000 },
    effects: defaultOwedWorkEffects,
    signal: new AbortController().signal
  });
  expect(outcome).toBe('done');
}

describe('the worker refresh scans with the recorded agent-home variables', () => {
  for (const { source, variable } of AGENTS) {
    it(`reads ${source} transcripts from the recorded ${variable}, not the worker's`, async () => {
      const hookHome = await mkdtemp(join(tmpdir(), `env-hook-${source}-`));
      await writeFixture(hookHome, source);
      try {
        await refreshWithRecorded({ [variable]: hookHome }, source);
        const state = await readState(home.statePath);
        expect(state.usageSnapshots?.['1']?.[source]).toMatchObject({ totalTokens: 100 });
      } finally {
        await rm(hookHome, { recursive: true, force: true });
      }
    });
  }

  it('reads no worker-only agent-home variable when the first boundary records none', async () => {
    // The day's first boundary is promoted to every built-in source. The worker
    // environment points each agent at a worker-home holding 100 tokens; none
    // of it is recorded, so every source reads its default root under the
    // refresh's home instead — empty, so every snapshot is 0.
    await refreshWithRecorded({}, 'claude');
    const state = await readState(home.statePath);
    for (const { source } of AGENTS) {
      expect(state.usageSnapshots?.['1']?.[source]?.totalTokens ?? 0).toBe(0);
    }
  });

  it('reads the default root under the refresh home for an agent whose variable was not recorded', async () => {
    // The codex default root ($HOME/.codex) holds 25 tokens; the worker-only
    // CODEX_HOME holds 100. The Claude first boundary records no variable, so
    // codex counts the default root's 25, not the worker's 100.
    await writeFixture(join(defaultHome, '.codex'), 'codex', 25);

    await refreshWithRecorded({}, 'claude');
    const state = await readState(home.statePath);
    expect(state.usageSnapshots?.['1']?.codex).toMatchObject({ totalTokens: 25 });
  });
});
