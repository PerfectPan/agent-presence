import { acquireLock } from '../src/process-lock.js';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { flush } from '../src/cli/commands/flush.js';
import { printStatus } from '../src/cli/commands/status.js';
import { reset } from '../src/cli/commands/reset.js';
import { update } from '../src/cli/commands/update.js';
import { readWorkerVersion, writeTombstone } from '../src/queue/files.js';
import { checkWorkerLock, produceRecord } from '../src/queue/produce.js';
import { listQueue } from '../src/queue/reader.js';
import { dshUsage, eventBody, readState, recordAt, until, writeState, T0 } from './queue-support.js';
import {
  capturePrint,
  createCommandHarness,
  mockNow,
  movableNow,
  TEMPLATES,
  type CommandHarness
} from './queue-command-harness.js';

// Plan 0003 3.7 and 3.8 for the state-changing commands: they take over, apply what is pending, and run today's code;
// under the tombstone they change nothing. The argv path is exercised through the takeover seam the commands accept
// behind their args, so time stays on the harness's virtual clock.

// A sync inside the debounce interval schedules a deferred flush as a detached process; record it instead.
const spawnMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => { unref: () => void; on: () => void }>(() => ({
    unref: () => undefined,
    on: () => undefined
  }))
);
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock
}));

const publishValueMock = vi.hoisted(() => vi.fn<(value: string) => Promise<void>>());
vi.mock('../src/providers/registry.js', () => ({
  createProvider: () => ({ id: 'feishu-signature', publishValue: publishValueMock })
}));

// The command's own usage refresh, spied so the tombstone pin can show it does not run. The rest of the module stays
// real, and the worker's refreshes run through the injected effects, not through this.
const refreshUsageMock = vi.hoisted(() =>
  vi.fn<typeof import('../src/cli/usage-badge.js').refreshSignatureUsageBadges>()
);
vi.mock('../src/cli/usage-badge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/cli/usage-badge.js')>()),
  refreshSignatureUsageBadges: refreshUsageMock
}));

vi.mock('../src/secret.js', () => ({
  readCredential: vi
    .fn<typeof import('../src/secret.js').readCredential>()
    .mockResolvedValue({ token: 'test-token', slotId: 'test-slot' })
}));

const OLDER = 1;
const NEWER = 2;

let h: CommandHarness;
let restoreNow: () => void = () => undefined;
let printed: ReturnType<typeof capturePrint> | undefined;

beforeEach(async () => {
  publishValueMock.mockReset().mockResolvedValue(undefined);
  refreshUsageMock.mockReset();
  spawnMock.mockClear();
  h = await createCommandHarness();
});

afterEach(async () => {
  restoreNow();
  printed?.restore();
  await h.dispose();
});

function nowAt(at: number): void {
  restoreNow();
  restoreNow = mockNow(at);
}

function capture(): ReturnType<typeof capturePrint> {
  printed?.restore();
  printed = capturePrint();
  return printed;
}

describe('status', () => {
  it('applies the pending records before it prints, appends their dsh usage, and leaves the worker lock free', async () => {
    nowAt(T0 + 2_000);
    await recordAt(h.home.statePath, T0, eventBody('SessionStart', 's1'));
    await recordAt(
      h.home.statePath,
      T0 + 1_000,
      eventBody('Heartbeat', 'd1', { source: 'dsh', usage: dshUsage, payloadKeys: ['usage'] })
    );
    const out = capture();

    await printStatus([], h.takeoverOptions());
    const reasons = await h.pool.settled();

    expect(reasons).toEqual(['idle']);
    expect(out.lines).toHaveLength(1);
    const payload = JSON.parse(out.lines[0]!) as {
      activeCount: number;
      value: string;
      active: Array<{ id: string }>;
    };
    expect(payload.activeCount).toBe(2);
    expect(payload.value).toBe('MANY codex 1 · dsh 1');
    expect(payload.active.map((session) => session.id).sort()).toEqual(['d1', 's1']);
    expect(h.fake.appended).toEqual([{ id: expect.any(String), usage: dshUsage }]);
    expect(h.fake.published).toEqual(['MANY codex 1 · dsh 1']);
    expect((await listQueue(h.home.statePath)).records).toEqual([]);
    expect((await checkWorkerLock(h.home.statePath)).held).toBe(false);
    expect(await readWorkerVersion(h.home.statePath)).toBe(0);
  });

  it('completes and prints with the log lock held: its dsh append waits the bounded wait and stays owed', async () => {
    nowAt(T0 + 2_000);
    await recordAt(
      h.home.statePath,
      T0 + 1_000,
      eventBody('Heartbeat', 'd1', { source: 'dsh', usage: dshUsage, payloadKeys: ['usage'] })
    );
    const lock = await acquireLock(`${h.home.usageEventsPath}.lock.db`, new AbortController().signal, { retryMs: 10 });
    const out = capture();
    const starts = h.countingStarts();
    try {
      await printStatus([], h.takeoverOptions({ logLockWaitMs: 0, startWorker: starts.startWorker }));

      expect(out.lines).toHaveLength(1);
      expect(JSON.parse(out.lines[0]!)).toMatchObject({ activeCount: 1 });
      expect(h.fake.appended).toEqual([]);
      expect((await readState(h.home.statePath)).queueOwed?.dshUsage).toHaveLength(1);
      // The append is left to the worker status starts when it leaves (3.6); the test counts instead of running it.
      expect(starts.count()).toBe(1);
    } finally {
      await lock.release();
    }
  });
});

describe('update', () => {
  it('update --force applies the pending events before it publishes their rendered value', async () => {
    nowAt(T0 + 2_000);
    await recordAt(h.home.statePath, T0, eventBody('SessionStart', 's1'));

    await update(['--force', '--silent'], h.takeoverOptions());
    await h.pool.settled();

    expect(publishValueMock).toHaveBeenCalledWith('ONE codex 1');
    expect((await readState(h.home.statePath)).sessions.s1).toMatchObject({ status: 'running' });
    expect((await listQueue(h.home.statePath)).records).toEqual([]);
    // The command's own sync settled the owed rendered sync, so the leaving worker starts for nothing else.
    expect(h.fake.published).toEqual([]);
  });

  it('update --value applies the pending events, and a worker run afterwards does not publish over the explicit value', async () => {
    nowAt(T0 + 2_000);
    await recordAt(h.home.statePath, T0, eventBody('SessionStart', 's1'));

    await update(['--value', 'explicit value', '--force'], h.takeoverOptions());

    expect(publishValueMock).toHaveBeenCalledWith('explicit value');
    expect((await readState(h.home.statePath)).sessions.s1).toMatchObject({ status: 'running' });
    expect((await readState(h.home.statePath)).queueOwed?.renderedSync).toBeUndefined();

    expect(await h.pool.start()).toBe('idle');
    await h.pool.settled();
    expect(h.fake.published).toEqual([]);
    expect((await readState(h.home.statePath)).lastValue).toBe('explicit value');
    expect((await listQueue(h.home.statePath)).records).toEqual([]);
  });
});

describe('flush', () => {
  it('applies a pending event recorded inside the debounce interval and schedules its publish', async () => {
    nowAt(T0);
    await writeState(h.home.statePath, { sessions: {}, lastSlotUpdateAt: T0 - 10_000, lastValue: 'old value' });
    await recordAt(h.home.statePath, T0 - 5_000, eventBody('SessionStart', 's1'));
    const out = capture();

    await flush([], h.takeoverOptions());
    await h.pool.settled();

    expect(out.lines).toHaveLength(1);
    expect(JSON.parse(out.lines[0]!)).toEqual({ status: 'skipped', reason: 'debounced', value: 'ONE codex 1' });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect((await readState(h.home.statePath)).sessions.s1).toMatchObject({ status: 'running' });
    expect((await listQueue(h.home.statePath)).records).toEqual([]);
  });

  it('applies a pending event recorded outside the debounce interval and publishes it', async () => {
    nowAt(T0);
    await writeState(h.home.statePath, { sessions: {}, lastSlotUpdateAt: T0 - 120_000, lastValue: 'old value' });
    await recordAt(h.home.statePath, T0 - 100_000, eventBody('SessionStart', 's1'));

    await flush([], h.takeoverOptions());
    await h.pool.settled();

    expect(publishValueMock).toHaveBeenCalledWith('ONE codex 1');
    expect(spawnMock).not.toHaveBeenCalled();
    expect((await readState(h.home.statePath)).sessions.s1).toMatchObject({ status: 'running' });
    expect((await listQueue(h.home.statePath)).records).toEqual([]);
  });
});

describe('reset during a slow usage refresh (Spec S6)', () => {
  it('takes over within its wait, applies the SessionStart, finishes every session, publishes, and leaves the refresh owed', async () => {
    nowAt(T0 + 2_000);
    await writeState(h.home.statePath, {
      sessions: {
        old: {
          id: 'old',
          source: 'codex',
          kind: 'coding',
          status: 'running',
          startedAt: T0 - 60_000,
          lastHeartbeatAt: T0 - 1_000
        }
      },
      queueOwed: { usageRefresh: [{ source: 'codex', scanEnv: {}, boundaryAt: T0, generation: 1 }] }
    });
    await recordAt(h.home.statePath, T0 + 2_000, eventBody('SessionStart', 's1'));
    const held = h.fake.holdRefreshes();
    const running = h.pool.start();
    const busyWith = await held.started;
    const starts = h.countingStarts();

    await reset(['--force', '--silent'], h.takeoverOptions({ startWorker: starts.startWorker }));
    await h.pool.settled();

    // The holder stopped for reset's request and left the refresh owed; the worker it started exits behind reset.
    expect(await running).toBe('stop-request');
    expect(busyWith.source).toBe('codex');
    expect(h.fake.refreshed).toHaveLength(1);
    const state = await readState(h.home.statePath);
    expect(Object.values(state.sessions).map((session) => session.status)).toEqual(['finished', 'finished']);
    expect(state.queueOwed?.usageRefresh).toEqual([{ source: 'codex', scanEnv: {}, boundaryAt: T0, generation: 1 }]);
    expect(publishValueMock).toHaveBeenCalledWith('ZERO');
    expect(h.fake.published).toEqual([]);
    expect((await listQueue(h.home.statePath)).records).toEqual([]);
    // Reset left the refresh to a worker: it starts one when it leaves (3.6), and the test counts instead of running it.
    expect(starts.count()).toBe(1);
  });

  it('reset applies a pending SessionStart, at its recorded time, before it finishes every session', async () => {
    // No worker runs, so only reset's takeover can apply the record.
    nowAt(T0 + 2_000);
    await writeState(h.home.statePath, {
      sessions: {
        old: {
          id: 'old',
          source: 'codex',
          kind: 'coding',
          status: 'running',
          startedAt: T0 - 60_000,
          lastHeartbeatAt: T0 - 1_000
        }
      }
    });
    await recordAt(h.home.statePath, T0, eventBody('SessionStart', 's1'));

    await reset(['--force', '--silent'], h.takeoverOptions());

    const state = await readState(h.home.statePath);
    expect(state.sessions.s1).toMatchObject({
      status: 'finished',
      startedAt: T0,
      lastHeartbeatAt: T0 + 2_000,
      finishedAt: T0 + 2_000
    });
    expect(publishValueMock).toHaveBeenCalledWith('ZERO');
    expect((await listQueue(h.home.statePath)).records).toEqual([]);
  });

  it('reads its now after the apply, so an applied record is never finished before it started', async () => {
    // A holder keeps reset waiting for the lock while the record is written, so the record can carry a later recorded
    // time than reset's first read of `now`.
    const now = movableNow(T0);
    restoreNow = () => now.restore();
    await writeState(h.home.statePath, { sessions: {} });
    const running = h.pool.start(1, { idleMs: 300_000 });
    await until(async () => (await readWorkerVersion(h.home.statePath)) === 1, 'the holder running');

    const command = reset(['--force', '--silent'], h.takeoverOptions());
    await until(async () => (await h.requestFiles()).length === 1, 'reset waiting for the lock');
    await recordAt(h.home.statePath, T0 + 3_000, eventBody('SessionStart', 's1'));
    now.set(T0 + 4_000);

    await command;
    await h.pool.settled();

    expect(await running).toBe('stop-request');
    const session = (await readState(h.home.statePath)).sessions.s1;
    expect(session).toMatchObject({
      status: 'finished',
      startedAt: T0 + 3_000,
      finishedAt: T0 + 4_000
    });
    expect((await readState(h.home.statePath)).lastSlotUpdateAt).toBe(T0 + 4_000);
  });
});

describe('commands under the tombstone', () => {
  async function tombstoned(): Promise<string> {
    await writeState(h.home.statePath, { sessions: {}, lastValue: 'kept value' });
    await recordAt(h.home.statePath, T0, eventBody('SessionStart', 's1'));
    await writeTombstone(h.home.statePath);
    return readFile(h.home.statePath, 'utf8');
  }

  it('reset changes nothing and reports the skipped disabled result', async () => {
    const before = await tombstoned();
    const out = capture();
    const starts = h.countingStarts();

    await reset(['--force'], h.takeoverOptions({ startWorker: starts.startWorker }));

    expect(JSON.parse(out.lines[0]!)).toEqual({ status: 'skipped', reason: 'disabled', value: 'kept value' });
    expect(await readFile(h.home.statePath, 'utf8')).toBe(before);
    expect((await listQueue(h.home.statePath)).records).toHaveLength(1);
    expect(publishValueMock).not.toHaveBeenCalled();
    expect(h.fake.published).toEqual([]);
    expect(starts.count()).toBe(0);
  });

  it('reset --silent prints nothing', async () => {
    await tombstoned();
    const out = capture();

    await reset(['--force', '--silent'], h.takeoverOptions());

    expect(out.lines).toEqual([]);
  });

  it('flush changes nothing and reports the skipped disabled result', async () => {
    const before = await tombstoned();
    const out = capture();

    await flush(['--force'], h.takeoverOptions());

    expect(JSON.parse(out.lines[0]!)).toEqual({ status: 'skipped', reason: 'disabled', value: 'kept value' });
    expect(await readFile(h.home.statePath, 'utf8')).toBe(before);
    expect((await listQueue(h.home.statePath)).records).toHaveLength(1);
    expect(publishValueMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('update --value changes nothing and reports the skipped disabled result', async () => {
    const before = await tombstoned();
    const out = capture();

    await update(['--value', 'new value', '--force'], h.takeoverOptions());

    expect(JSON.parse(out.lines[0]!)).toEqual({ status: 'skipped', reason: 'disabled', value: 'kept value' });
    expect(await readFile(h.home.statePath, 'utf8')).toBe(before);
    expect((await listQueue(h.home.statePath)).records).toHaveLength(1);
    expect(publishValueMock).not.toHaveBeenCalled();
  });

  it('update --force changes nothing and reports the skipped disabled result', async () => {
    // Usage rendering on, so the tombstone check is what keeps the command's own usage refresh from running.
    await h.home.writeConfig({
      provider: 'feishu-signature',
      render: TEMPLATES,
      usage: { showInSignature: true, signatureWindowDays: 1 }
    });
    const before = await tombstoned();
    const out = capture();

    await update(['--force'], h.takeoverOptions());

    expect(JSON.parse(out.lines[0]!)).toEqual({ status: 'skipped', reason: 'disabled', value: 'kept value' });
    expect(await readFile(h.home.statePath, 'utf8')).toBe(before);
    expect((await listQueue(h.home.statePath)).records).toHaveLength(1);
    expect(publishValueMock).not.toHaveBeenCalled();
    expect(refreshUsageMock).not.toHaveBeenCalled();
    expect(h.fake.published).toEqual([]);
  });

  it('status prints from the loaded state without saving', async () => {
    nowAt(T0 + 1_000);
    const before = await tombstoned();
    const out = capture();

    await printStatus([], h.takeoverOptions());

    expect(JSON.parse(out.lines[0]!)).toEqual({
      activeCount: 0,
      value: 'ZERO',
      active: [],
      provider: 'feishu-signature',
      lastValue: 'kept value',
      lastSlotUpdateAt: 0,
      statePath: h.home.statePath,
      hasToken: true,
      slotId: 'test-slot'
    });
    expect(await readFile(h.home.statePath, 'utf8')).toBe(before);
    expect((await listQueue(h.home.statePath)).records).toHaveLength(1);
    expect(publishValueMock).not.toHaveBeenCalled();
    expect(h.fake.published).toEqual([]);
  });
});

describe('commands of an older release (section 7, option (a))', () => {
  it('an older reset finishes every session and publishes, leaves the newer SessionStart pending, and a newer worker applies it', async () => {
    nowAt(T0 + 2_000);
    await writeState(h.home.statePath, {
      sessions: {
        old: {
          id: 'old',
          source: 'codex',
          kind: 'coding',
          status: 'running',
          startedAt: T0 - 60_000,
          lastHeartbeatAt: T0 - 1_000
        }
      }
    });
    await recordAt(h.home.statePath, T0, eventBody('Heartbeat', 'old'), { version: OLDER });
    await recordAt(h.home.statePath, T0 + 1_000, eventBody('SessionStart', 'fresh'), { version: NEWER });

    await reset(['--force', '--silent'], h.takeoverOptions({ version: OLDER }));
    expect(await h.pool.settled()).toEqual(['newer-record']);

    const afterReset = await readState(h.home.statePath);
    expect(afterReset.sessions.old).toMatchObject({ status: 'finished' });
    expect(afterReset.sessions.fresh).toBeUndefined();
    expect(publishValueMock).toHaveBeenCalledWith('ZERO');
    expect((await listQueue(h.home.statePath)).records).toHaveLength(1);

    // The newer worker the next producer would start applies the SessionStart after the older reset.
    expect(await h.pool.start(NEWER)).toBe('idle');
    const state = await readState(h.home.statePath);
    expect(state.sessions.fresh).toMatchObject({ status: 'running', startedAt: T0 + 1_000 });
    expect(state.queueOwed?.renderedSync).toBeUndefined();
    expect((await listQueue(h.home.statePath)).records).toEqual([]);
  });

  it('an older command holding the lock past 60 seconds leaves a newer record pending, and the next producer applies it', async () => {
    nowAt(T0 + 2_000);
    await writeState(h.home.statePath, { sessions: {}, lastSlotUpdateAt: 0, lastValue: '' });
    // The command's own publish resolves only when the test releases it, so the command holds the lock that long.
    let releasePublish: () => void = () => undefined;
    publishValueMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releasePublish = resolve;
        })
    );

    const command = flush(['--force', '--silent'], h.takeoverOptions({ version: OLDER }));
    await until(() => publishValueMock.mock.calls.length > 0, 'the command reaching its publish');

    // A producer of the newer release records while the older command holds the lock; its worker waits out the 60s.
    const produced = await produceRecord(h.home.statePath, eventBody('SessionStart', 'n1'), {
      version: NEWER,
      clock: { now: () => T0 + 3_000 }
    });
    expect(produced).toMatchObject({ status: 'recorded', startWorker: true });
    expect(await h.pool.start(NEWER)).toBe('limit');

    releasePublish();
    await command;
    expect(await h.pool.settled()).toEqual(['limit', 'newer-record']);
    expect((await listQueue(h.home.statePath)).records).toHaveLength(1);

    const next = await produceRecord(h.home.statePath, eventBody('SessionStart', 'n2'), {
      version: NEWER,
      clock: { now: () => T0 + 4_000 }
    });
    expect(next).toMatchObject({ status: 'recorded', startWorker: true });
    void h.pool.start(NEWER);
    await h.pool.settled();

    const sessions = (await readState(h.home.statePath)).sessions;
    expect(sessions.n1).toMatchObject({ status: 'running' });
    expect(sessions.n2).toMatchObject({ status: 'running' });
    expect((await listQueue(h.home.statePath)).records).toEqual([]);
  });
});
