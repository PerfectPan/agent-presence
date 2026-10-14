import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { loadConfig } from '../src/config.js';
import { applyQueueBatch, type BatchStep } from '../src/queue/apply.js';
import { increaseEpoch, queuePaths, recordFileName } from '../src/queue/files.js';
import type { PresenceState } from '../src/state.js';
import {
  createQueueHome,
  dshUsage,
  eventBody,
  readRawState,
  readState,
  recordAt,
  T0,
  writeState,
  type QueueHome
} from './queue-support.js';

let home: QueueHome;
const clock = { now: () => T0 + 60_000 };

beforeEach(async () => {
  home = await createQueueHome();
});

afterEach(async () => {
  await home.dispose();
});

async function batch(options: { version?: number; onStep?: (step: BatchStep) => Promise<void> } = {}) {
  return applyQueueBatch(home.statePath, {
    version: options.version ?? 1,
    config: await loadConfig(),
    clock,
    onStep: options.onStep
  });
}

async function recordNames(): Promise<string[]> {
  return (await readdir(queuePaths(home.statePath).queueDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

function sessionsOf(state: PresenceState) {
  return state.sessions;
}

describe('applyQueueBatch', () => {
  it('applies records in recorded-time order at their recorded times, saves their ids, and deletes their files', async () => {
    const stop = await recordAt(home.statePath, T0 + 2_000, eventBody('Stop', 's1'));
    const start = await recordAt(home.statePath, T0 + 1_000, eventBody('SessionStart', 's1'));

    expect(await batch()).toEqual({ listed: 2, applied: 2, appliedEvents: true, newer: false });

    const state = await readState(home.statePath);
    expect(state.sessions.s1).toMatchObject({
      status: 'finished',
      startedAt: T0 + 1_000,
      lastHeartbeatAt: T0 + 2_000,
      finishedAt: T0 + 2_000
    });
    expect(state.queueApplied).toEqual([start, stop]);
    expect(await recordNames()).toEqual([]);
  });

  it('applies a fallback finish and a reopen once when the applier died between its save and the deletions', async () => {
    await recordAt(home.statePath, T0 + 1_000, eventBody('SessionStart', 'a'));
    await recordAt(home.statePath, T0 + 2_000, eventBody('SessionStart', 'b'));
    await recordAt(home.statePath, T0 + 3_000, eventBody('Stop', 'b'));
    // No session `z`: finishes the latest running session of the source, `a`.
    await recordAt(home.statePath, T0 + 4_000, eventBody('Stop', 'z'));
    // Reopens the finished `b`.
    await recordAt(home.statePath, T0 + 5_000, eventBody('UserPromptSubmit', 'b'));

    const killed = batch({
      onStep: async (step) => {
        if (step === 'saved') {
          throw new Error('killed after the save');
        }
      }
    });
    await expect(killed).rejects.toThrow('killed after the save');
    const saved = await readState(home.statePath);
    expect(await recordNames()).toHaveLength(5);
    expect(saved.queueApplied).toHaveLength(5);

    expect(await batch()).toEqual({ listed: 5, applied: 0, appliedEvents: false, newer: false });

    const state = await readState(home.statePath);
    expect(sessionsOf(state)).toEqual(sessionsOf(saved));
    expect(state.sessions.a).toMatchObject({ status: 'finished', finishedAt: T0 + 4_000 });
    expect(state.sessions.b).toMatchObject({ status: 'running', startedAt: T0 + 5_000 });
    expect(await recordNames()).toEqual([]);
  });

  it('drops the ids whose files are gone from the applied ids at its next save', async () => {
    const first = await recordAt(home.statePath, T0 + 1_000, eventBody('SessionStart', 's1'));
    await batch();
    expect((await readState(home.statePath)).queueApplied).toEqual([first]);

    const second = await recordAt(home.statePath, T0 + 2_000, eventBody('Heartbeat', 's1'));
    await batch();

    expect((await readState(home.statePath)).queueApplied).toEqual([second]);
  });

  it('stops at a record with a higher version: it applies the records before it and leaves it and the rest in place', async () => {
    const older = await recordAt(home.statePath, T0 + 1_000, eventBody('SessionStart', 'old'));
    const newer = await recordAt(home.statePath, T0 + 2_000, eventBody('SessionStart', 'new'), { version: 2 });
    const after = await recordAt(home.statePath, T0 + 3_000, eventBody('SessionStart', 'after'));

    expect(await batch()).toEqual({ listed: 3, applied: 1, appliedEvents: true, newer: true });

    const state = await readState(home.statePath);
    expect(Object.keys(state.sessions)).toEqual(['old']);
    expect(state.queueApplied).toEqual([older]);
    expect(await recordNames()).toEqual([`${newer}.json`, `${after}.json`]);
  });

  it('applies the records of its own version and older ones, as a newer applier does', async () => {
    await recordAt(home.statePath, T0 + 1_000, eventBody('SessionStart', 'old'), { version: 1 });
    await recordAt(home.statePath, T0 + 2_000, eventBody('SessionStart', 'new'), { version: 2 });

    expect(await batch({ version: 2 })).toMatchObject({ applied: 2, newer: false });
    expect(Object.keys((await readState(home.statePath)).sessions).sort()).toEqual(['new', 'old']);
  });

  it('moves a bad record to failed/ and applies the others', async () => {
    const { queueDir, failedDir } = queuePaths(home.statePath);
    await mkdir(queueDir, { recursive: true });
    const broken = recordFileName(T0 + 1_000, 7, 'aaaa');
    await writeFile(join(queueDir, broken), '{"v":1,');
    const invalid = recordFileName(T0 + 1_500, 7, 'bbbb');
    await writeFile(
      join(queueDir, invalid),
      JSON.stringify({ v: 1, id: invalid.slice(0, -5), recordedAt: T0 + 1_500, epoch: 0, kind: 'later-kind' })
    );
    await recordAt(home.statePath, T0 + 2_000, eventBody('SessionStart', 's1'));

    expect(await batch()).toMatchObject({ listed: 3, applied: 1 });

    expect((await readdir(failedDir)).sort()).toEqual([broken, invalid].sort());
    expect(await recordNames()).toEqual([]);
    expect(Object.keys((await readState(home.statePath)).sessions)).toEqual(['s1']);
    expect(await readFile(home.logPath, 'utf8')).toContain('type=queue.record.failed');
  });

  it('deletes a record of another epoch without applying it', async () => {
    await recordAt(home.statePath, T0 + 1_000, eventBody('SessionStart', 'before-setup'), { epoch: 0 });
    await increaseEpoch(home.statePath);
    await recordAt(home.statePath, T0 + 2_000, eventBody('SessionStart', 'after-setup'), { epoch: 1 });

    expect(await batch()).toMatchObject({ listed: 2, applied: 1 });

    expect(Object.keys((await readState(home.statePath)).sessions)).toEqual(['after-setup']);
    expect(await recordNames()).toEqual([]);
  });

  it('records skip and error records once, changing nothing but writing their log lines', async () => {
    const skip = await recordAt(home.statePath, T0 + 1_000, {
      kind: 'skip',
      code: 'ignored-event',
      source: 'pi',
      nativeEvent: 'session_start',
      payloadKeys: []
    });
    const later = await recordAt(home.statePath, T0 + 1_500, {
      kind: 'skip',
      code: 'later-code',
      agent: 'cursor',
      nativeEvent: 'stop',
      payloadKeys: []
    });
    const error = await recordAt(home.statePath, T0 + 2_000, {
      kind: 'error',
      code: 'resolver-failed',
      source: 'codex',
      message: 'source resolver failed source=codex error=TypeError'
    });

    expect(await batch()).toEqual({ listed: 3, applied: 3, appliedEvents: false, newer: false });

    const raw = await readRawState(home.statePath);
    expect(raw.sessions).toEqual({});
    expect(raw.queueOwed).toBeUndefined();
    expect(raw.queueApplied).toEqual([skip, later, error]);
    const log = await readFile(home.logPath, 'utf8');
    expect(log).toContain('hook skipped: ignored event source=pi event=session_start');
    expect(log).toContain('hook skipped: code=later-code source=cursor event=stop');
    expect(log).toContain('source resolver failed source=codex error=TypeError');
  });

  it('writes the diagnostic line of each event with its payload key names and a redacted session id', async () => {
    await recordAt(
      home.statePath,
      T0 + 1_000,
      eventBody('SessionStart', 'session-0123456789', { payloadKeys: ['prompt'] })
    );

    await batch();

    const log = await readFile(home.logPath, 'utf8');
    expect(log).toContain(
      'type=hook.event source=codex event=SessionStart hasSessionId=true sessionId=session-...6789'
    );
    expect(log).toContain('payloadKeys=[prompt]');
    expect(log).not.toContain('session-0123456789');
  });
});

describe('owed work of applied records', () => {
  it('owes a dsh append per usage event, one refresh per boundary source and scanEnv, and the rendered sync', async () => {
    const usage = { ...dshUsage, costUsd: 0.25 };
    const dsh = await recordAt(
      home.statePath,
      T0 + 1_000,
      eventBody('Heartbeat', 'd1', { source: 'dsh', usage, payloadKeys: ['usage'] })
    );
    await recordAt(
      home.statePath,
      T0 + 2_000,
      eventBody('SessionStart', 'c1', { source: 'claude', scanEnv: { CLAUDE_CONFIG_DIR: '/fake-home/a' } })
    );
    await recordAt(home.statePath, T0 + 3_000, eventBody('Heartbeat', 'c1', { source: 'claude' }));
    await recordAt(home.statePath, T0 + 4_000, eventBody('SubagentStart', 'c1', { source: 'claude' }));
    await recordAt(
      home.statePath,
      T0 + 5_000,
      eventBody('Stop', 'c1', { source: 'claude', scanEnv: { CLAUDE_CONFIG_DIR: '/fake-home/a' } })
    );
    await recordAt(
      home.statePath,
      T0 + 6_000,
      eventBody('SessionStart', 'c2', { source: 'claude', scanEnv: { CLAUDE_CONFIG_DIR: '/fake-home/b' } })
    );
    await recordAt(home.statePath, T0 + 7_000, eventBody('SessionStart', 'x1'));

    await batch();

    expect((await readRawState(home.statePath)).queueOwed).toEqual({
      dshUsage: [{ id: dsh, usage }],
      usageRefresh: [
        { source: 'claude', scanEnv: { CLAUDE_CONFIG_DIR: '/fake-home/a' }, boundaryAt: T0 + 5_000, generation: 2 },
        { source: 'claude', scanEnv: { CLAUDE_CONFIG_DIR: '/fake-home/b' }, boundaryAt: T0 + 6_000, generation: 1 },
        { source: 'codex', scanEnv: {}, boundaryAt: T0 + 7_000, generation: 1 }
      ],
      renderedSync: true
    });
  });

  it('merges boundaries whose scanEnv differs only in key order, and keeps apart those differing in an unknown key', async () => {
    await recordAt(
      home.statePath,
      T0 + 1_000,
      eventBody('SessionStart', 'c1', {
        source: 'claude',
        scanEnv: { LATER_HOME: '/fake-home/later', CLAUDE_CONFIG_DIR: '/fake-home/a' }
      })
    );
    await recordAt(
      home.statePath,
      T0 + 2_000,
      eventBody('Stop', 'c1', {
        source: 'claude',
        scanEnv: { CLAUDE_CONFIG_DIR: '/fake-home/a', LATER_HOME: '/fake-home/later' }
      })
    );
    await recordAt(
      home.statePath,
      T0 + 3_000,
      eventBody('SessionStart', 'c2', { source: 'claude', scanEnv: { CLAUDE_CONFIG_DIR: '/fake-home/a' } })
    );

    await batch();

    const refreshes = (await readState(home.statePath)).queueOwed?.usageRefresh;
    expect(refreshes?.map(({ scanEnv, generation }) => ({ scanEnv, generation }))).toEqual([
      { scanEnv: { LATER_HOME: '/fake-home/later', CLAUDE_CONFIG_DIR: '/fake-home/a' }, generation: 2 },
      { scanEnv: { CLAUDE_CONFIG_DIR: '/fake-home/a' }, generation: 1 }
    ]);
  });

  it('owes no refresh while the signature renders no usage', async () => {
    await home.writeConfig({ provider: 'feishu-signature' });
    await recordAt(home.statePath, T0 + 1_000, eventBody('SessionStart', 's1'));

    await batch();

    expect((await readRawState(home.statePath)).queueOwed).toEqual({ renderedSync: true });
  });

  it('updates an owed entry in place and keeps the owed work and fields it does not know', async () => {
    const laterEntry = {
      source: 'codex',
      scanEnv: {},
      boundaryAt: T0,
      generation: 4,
      reason: 'boundary'
    };
    await writeState(home.statePath, {
      sessions: {},
      queueOwed: { usageRefresh: [laterEntry], laterKind: [{ anything: { nested: [1] } }] }
    });
    await recordAt(home.statePath, T0 + 1_000, eventBody('SessionStart', 's1'));

    await batch();

    expect((await readRawState(home.statePath)).queueOwed).toEqual({
      usageRefresh: [{ ...laterEntry, boundaryAt: T0 + 1_000, generation: 5 }],
      laterKind: [{ anything: { nested: [1] } }],
      renderedSync: true
    });
  });
});
