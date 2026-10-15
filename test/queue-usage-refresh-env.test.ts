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
async function writeFixture(root: string, agent: string, tokens = 100, atMs = T0 - 1000): Promise<void> {
  const write = async (segments: string[], content: string, quiet: boolean, mtimeMs = atMs): Promise<void> => {
    const file = join(root, ...segments);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
    const at = new Date(quiet ? Math.min(QUIET, mtimeMs) : mtimeMs);
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
    const at = new Date(atMs);
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
  // holding a real 40-token fixture — a different count than the recorded
  // side's 100, so a snapshot tells which side was read. Only a recorded
  // variable may lead the scan there.
  for (const agent of AGENTS) {
    const workerDir = join(defaultHome, 'worker-env', agent.source);
    await writeFixture(workerDir, agent.source, 40);
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

/** Work off every owed usage refresh entry, in queue order, with the real chain. */
async function workOffAllRefreshes(): Promise<void> {
  const config = await loadConfig();
  for (;;) {
    const state = await readState(home.statePath);
    const item = doableOwedItems(state.queueOwed, knownSources(config)).find(
      (candidate) => candidate.kind === 'usageRefresh'
    );
    if (!item) {
      return;
    }
    const outcome = await workOffOwedItem(item, {
      statePath: home.statePath,
      config,
      clock: { now: () => T0 + 9_000 },
      effects: defaultOwedWorkEffects,
      signal: new AbortController().signal
    });
    expect(outcome).toBe('done');
  }
}

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
    // The day's first boundary is promoted to every built-in source. Nothing
    // is recorded, so every source reads its default root under the refresh's
    // home instead of the worker's CODEX_HOME and friends — the defaults are
    // empty, so every snapshot counts 0.
    await refreshWithRecorded({}, 'claude');
    const state = await readState(home.statePath);
    for (const { source } of AGENTS) {
      expect(state.usageSnapshots?.['1']?.[source]?.totalTokens ?? 0).toBe(0);
    }
  });

  it('leaves a source with its own owed entry to that entry when a promoted refresh shares the batch', async () => {
    // One batch: claude(T1), codex(T2, recording CODEX_HOME), claude(T3). The
    // claude entry is promoted to every built-in source at T3 — but codex has
    // its own entry, which scans codex with its recorded environment, so the
    // promoted scan skips codex instead of stamping it from the worker's
    // 40-token CODEX_HOME.
    const hookCodex = await mkdtemp(join(tmpdir(), 'env-hook-codex-'));
    await writeFixture(hookCodex, 'codex', 100);
    try {
      for (const [at, source, scanEnv] of [
        [T0, 'claude', {}],
        [T0 + 1_000, 'codex', { CODEX_HOME: hookCodex }],
        [T0 + 2_000, 'claude', {}]
      ] as const) {
        await recordAt(home.statePath, at, eventBody('SessionStart', `s_${source}_${at}`, { source, scanEnv }));
      }
      await applyQueueBatch(home.statePath, {
        version: 1,
        config: await loadConfig(),
        clock: { now: () => T0 + 3_000 }
      });
      const config = await loadConfig();

      const items = doableOwedItems((await readState(home.statePath)).queueOwed, knownSources(config)).filter(
        (candidate) => candidate.kind === 'usageRefresh'
      );
      for (const item of items) {
        const outcome = await workOffOwedItem(item, {
          statePath: home.statePath,
          config,
          clock: { now: () => T0 + 4_000 },
          effects: defaultOwedWorkEffects,
          signal: new AbortController().signal
        });
        expect(outcome).toBe('done');
      }

      const state = await readState(home.statePath);
      // Codex carries its own recorded-environment scan (100), not the promoted
      // scan's worker-environment stamp (40); claude reads its empty default.
      expect(state.usageSnapshots?.['1']?.codex).toMatchObject({ totalTokens: 100 });
      expect(state.usageSnapshots?.['1']?.claude).toMatchObject({ totalTokens: 0 });
    } finally {
      await rm(hookCodex, { recursive: true, force: true });
    }
  });

  it('lets a promoted refresh fill the day without overwriting a snapshot it did not scan', async () => {
    // The day's first two boundaries: claude records CLAUDE_CONFIG_DIR, codex
    // records CODEX_HOME. Claude's promoted refresh fills codex? No — codex has
    // its own owed entry bounded today, so claude's scan leaves codex to it;
    // codex's own refresh is then promoted (the badge is still missing) and
    // scans codex plus the sources the day still lacks — claude already has a
    // snapshot from claude's own scan and is not overwritten.
    const hookClaude = await mkdtemp(join(tmpdir(), 'env-hook-claude-'));
    const hookCodex = await mkdtemp(join(tmpdir(), 'env-hook-codex-'));
    await writeFixture(hookClaude, 'claude', 100);
    await writeFixture(hookCodex, 'codex', 100);
    try {
      await recordAt(
        home.statePath,
        T0,
        eventBody('SessionStart', 's_claude_1', {
          source: 'claude',
          scanEnv: { CLAUDE_CONFIG_DIR: hookClaude }
        })
      );
      await recordAt(
        home.statePath,
        T0 + 1_000,
        eventBody('SessionStart', 's_codex_1', {
          source: 'codex',
          scanEnv: { CODEX_HOME: hookCodex }
        })
      );
      await applyQueueBatch(home.statePath, {
        version: 1,
        config: await loadConfig(),
        clock: { now: () => T0 + 2_000 }
      });
      await workOffAllRefreshes();

      const state = await readState(home.statePath);
      expect(state.usageSnapshots?.['1']?.claude).toMatchObject({ totalTokens: 100 });
      expect(state.usageSnapshots?.['1']?.codex).toMatchObject({ totalTokens: 100 });
      expect(state.usageBadges?.['1']).toBe('200');
      expect(state.usageBadgesAt).toBe(T0 + 1_000);
    } finally {
      await rm(hookClaude, { recursive: true, force: true });
      await rm(hookCodex, { recursive: true, force: true });
    }
  });

  it('scans a source with its own owed entry from that entry in a shared batch', async () => {
    // One batch: claude(T1), codex(T2 recording CODEX_HOME), claude(T3).
    // Claude's promoted refresh leaves codex to codex's own entry, which scans
    // it with the recorded environment; a scan stamp from claude's environment
    // must not survive.
    const hookCodex = await mkdtemp(join(tmpdir(), 'env-hook-codex-'));
    await writeFixture(hookCodex, 'codex', 100);
    try {
      for (const [at, source, scanEnv] of [
        [T0, 'claude', {}],
        [T0 + 1_000, 'codex', { CODEX_HOME: hookCodex }],
        [T0 + 2_000, 'claude', {}]
      ] as const) {
        await recordAt(home.statePath, at, eventBody('SessionStart', `s_${source}_${at}`, { source, scanEnv }));
      }
      await applyQueueBatch(home.statePath, {
        version: 1,
        config: await loadConfig(),
        clock: { now: () => T0 + 3_000 }
      });
      await workOffAllRefreshes();

      const state = await readState(home.statePath);
      expect(state.usageSnapshots?.['1']?.codex).toMatchObject({ totalTokens: 100 });
      expect(state.usageSnapshots?.['1']?.claude).toMatchObject({ totalTokens: 0 });
    } finally {
      await rm(hookCodex, { recursive: true, force: true });
    }
  });

  it('rebuilds the badge for the new day when a batch crosses midnight', async () => {
    // codex(D1 23:58), claude(D1 23:59), codex(D2 00:01): the codex entry's
    // boundary moves to D2, claude's stays on D1. Codex's own refresh runs on
    // D2 and fills the day for every source; claude's later work-off stamps
    // only claude's D1 snapshot, which is older than the D2 one and loses.
    const hookCodex = await mkdtemp(join(tmpdir(), 'env-hook-codex-'));
    const d1Evening = new Date(2025, 9, 5, 20, 0, 0, 0).getTime();
    const d2Early = new Date(2025, 9, 6, 0, 0, 30, 0).getTime();
    await writeFixture(hookCodex, 'codex', 100, d1Evening);
    try {
      // A second codex call just after midnight, so the D2 window counts 30.
      const rollout = join(hookCodex, 'sessions', 'rollout-poison-d2.jsonl');
      const iso2 = new Date(d2Early).toISOString();
      await writeFile(
        rollout,
        `${JSON.stringify({
          timestamp: iso2,
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 20, total_tokens: 30 },
              last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 20, total_tokens: 30 }
            }
          }
        })}\n`,
        'utf8'
      );
      await utimes(rollout, new Date(d2Early), new Date(d2Early));

      const codexScanEnv = { CODEX_HOME: hookCodex };
      await recordAt(
        home.statePath,
        new Date(2025, 9, 5, 23, 58).getTime(),
        eventBody('SessionStart', 's_codex_d1', {
          source: 'codex',
          scanEnv: codexScanEnv
        })
      );
      await recordAt(
        home.statePath,
        new Date(2025, 9, 5, 23, 59).getTime(),
        eventBody('SessionStart', 's_claude_d1', {
          source: 'claude',
          scanEnv: {}
        })
      );
      await recordAt(
        home.statePath,
        new Date(2025, 9, 6, 0, 1).getTime(),
        eventBody('SessionStart', 's_codex_d2', {
          source: 'codex',
          scanEnv: codexScanEnv
        })
      );
      await applyQueueBatch(home.statePath, {
        version: 1,
        config: await loadConfig(),
        clock: { now: () => new Date(2025, 9, 6, 0, 2).getTime() }
      });
      await workOffAllRefreshes();

      const state = await readState(home.statePath);
      // The D2 badge: codex's 30-token call after midnight, every other source's
      // zero for the new day.
      expect(state.usageBadges?.['1']).toBe('30');
      expect(state.usageBadgesAt).toBe(new Date(2025, 9, 6, 0, 1).getTime());
      expect(state.usageSnapshots?.['1']?.codex).toMatchObject({ totalTokens: 30 });
      expect(state.usageSnapshots?.['1']?.claude).toMatchObject({ totalTokens: 0 });
    } finally {
      await rm(hookCodex, { recursive: true, force: true });
    }
  });

  it('reads the default root under the refresh home for an agent whose variable was not recorded', async () => {
    // The codex default root ($HOME/.codex) holds 25 tokens; the worker-only
    // CODEX_HOME holds 40. The Claude first boundary records no variable, so
    // the promoted scan reads the default root and counts its 25 — not the
    // worker's 40.
    await writeFixture(join(defaultHome, '.codex'), 'codex', 25);

    await refreshWithRecorded({}, 'claude');
    const state = await readState(home.statePath);
    expect(state.usageSnapshots?.['1']?.codex).toMatchObject({ totalTokens: 25 });
  });
});
