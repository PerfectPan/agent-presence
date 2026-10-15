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
// has is not read. Real fixtures and the real scan; no module mocks.

const MINUTE = 60_000;
const QUIET = T0 - 31 * MINUTE;
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  // The worker's environment points every agent at its worker-home; only a
  // recorded variable may lead the scan elsewhere.
  process.env.CLAUDE_CONFIG_DIR = '/worker-env/claude';
  process.env.CODEX_HOME = '/worker-env/codex';
  process.env.GEMINI_CLI_HOME = '/worker-env/gemini';
  process.env.GROK_HOME = '/worker-env/grok';
  process.env.XDG_DATA_HOME = '/worker-env/xdg';
  process.env.PI_CODING_AGENT_DIR = '/worker-env/pi';
});

const savedEnv = new Map<string, string | undefined>(
  ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'GROK_HOME', 'XDG_DATA_HOME', 'PI_CODING_AGENT_DIR'].map(
    (name) => [name, process.env[name]]
  )
);

afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

/** One transcript worth 100 tokens under `root`, laid out as the agent keeps it. */
async function writeFixture(root: string, agent: string): Promise<void> {
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
        message: { id: 'msg_env', model: 'mystery-model', usage: { input_tokens: 90, output_tokens: 10 } }
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
            total_token_usage: { input_tokens: 80, cached_input_tokens: 0, output_tokens: 20, total_tokens: 100 },
            last_token_usage: { input_tokens: 80, cached_input_tokens: 0, output_tokens: 20, total_tokens: 100 }
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
        tokens: { input: 60, output: 40 }
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
            usage: { inputTokens: 70, outputTokens: 30, totalTokens: 100 }
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
          usage: { input: 70, output: 30, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }
        }
      })}\n`,
      false
    );
  }
}

const AGENTS: Array<{ source: string; variable: string }> = [
  { source: 'claude', variable: 'CLAUDE_CONFIG_DIR' },
  { source: 'codex', variable: 'CODEX_HOME' },
  { source: 'gemini', variable: 'GEMINI_CLI_HOME' },
  { source: 'grok', variable: 'GROK_HOME' },
  { source: 'opencode', variable: 'XDG_DATA_HOME' },
  { source: 'pi', variable: 'PI_CODING_AGENT_DIR' }
];

let home: QueueHome;

beforeEach(async () => {
  home = await createQueueHome();
});

afterEach(async () => {
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

  it('reads none of the worker environment value the entry did not record', async () => {
    // The worker env names /worker-env/* (set above); no fixture exists there,
    // and the entry records no variable, so the scan reads the default roots
    // under the platform home instead — all empty.
    for (const { source } of AGENTS) {
      await refreshWithRecorded({}, source);
      const state = await readState(home.statePath);
      expect(state.usageSnapshots?.['1']?.[source]?.totalTokens ?? 0).toBe(0);
    }
  });
});
