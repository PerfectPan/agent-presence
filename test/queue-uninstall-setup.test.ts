import { stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { setup } from '../src/cli/commands/setup.js';
import { uninstall } from '../src/cli/commands/uninstall.js';
import { fileExists, isDisabled, queuePaths, readEpoch, readWorkerVersion } from '../src/queue/files.js';
import type { Delay } from '../src/queue/stop-request.js';
import { produceRecord } from '../src/queue/produce.js';
import { listQueue } from '../src/queue/reader.js';
import { stopWorker } from '../src/queue/takeover.js';
import { eventBody, readState, recordAt, until, writeState, T0 } from './queue-support.js';
import { createCommandHarness, type CommandHarness } from './queue-command-harness.js';
import { createHarnessFixture, type HarnessFixture } from './harness-support.js';

// `uninstall --all` writes the tombstone, empties the queue under a takeover, and keeps the lock and the epoch;
// `setup` removes a tombstone, raises the epoch, and lets records apply again; without a tombstone it leaves the queue
// alone. The downgrade between queue releases runs the same setup of an older release through the seam.

// No detached process may leave a test: every start goes through the seam, and a stray spawn is recorded here.
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

const runUninstallScriptsMock = vi.hoisted(() =>
  vi.fn<typeof import('../src/setup.js').runUninstallScripts>(async () => [])
);
const runSetupScriptsMock = vi.hoisted(() => vi.fn<typeof import('../src/setup.js').runSetupScripts>(async () => []));
const removePluginsDirMock = vi.hoisted(() =>
  vi.fn<typeof import('../src/plugin-install.js').removePluginsDir>(async () => undefined)
);
const deleteCredentialMock = vi.hoisted(() =>
  vi.fn<typeof import('../src/secret.js').deleteCredential>(async () => undefined)
);

vi.mock('../src/setup.js', () => ({
  LINUX_WATCHER_SKIP_MESSAGE: 'linux watcher skipped',
  platformUninstallScriptNames: () => ['uninstall-dsh-plugin.js', 'uninstall-shutdown-watcher.js'],
  runSetupScripts: runSetupScriptsMock,
  runUninstallScripts: runUninstallScriptsMock
}));

vi.mock('../src/plugin-install.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/plugin-install.js')>()),
  removePluginsDir: removePluginsDirMock
}));

vi.mock('../src/secret.js', () => ({
  // No credential: `setup` takes the branch that only reports the missing login.
  readCredential: vi.fn<typeof import('../src/secret.js').readCredential>(async () => undefined),
  deleteCredential: deleteCredentialMock
}));

vi.mock('../src/migration.js', () => ({
  cleanupMigratedLegacyHome: vi.fn<typeof import('../src/migration.js').cleanupMigratedLegacyHome>(async () => ({
    from: '',
    to: '',
    removed: []
  })),
  hasLegacyHomeToMigrate: vi.fn<typeof import('../src/migration.js').hasLegacyHomeToMigrate>(async () => false),
  migrateLegacyHome: vi.fn<typeof import('../src/migration.js').migrateLegacyHome>()
}));

vi.mock('../src/cli/ui.js', () => ({
  createSpinner: () => ({
    start: vi.fn<(message?: string) => void>(),
    stop: vi.fn<(message?: string) => void>(),
    error: vi.fn<(message?: string) => void>()
  }),
  finishOutro: vi.fn<typeof import('../src/cli/ui.js').finishOutro>(),
  isInteractiveTerminal: vi.fn<typeof import('../src/cli/ui.js').isInteractiveTerminal>(() => false),
  promptConfirm: vi.fn<typeof import('../src/cli/ui.js').promptConfirm>(),
  promptText: vi.fn<typeof import('../src/cli/ui.js').promptText>(),
  showInfo: vi.fn<typeof import('../src/cli/ui.js').showInfo>(),
  showNote: vi.fn<typeof import('../src/cli/ui.js').showNote>(),
  startIntro: vi.fn<typeof import('../src/cli/ui.js').startIntro>()
}));

const OLDER = 1;
const NEWER = 2;

let h: CommandHarness;
let harness: HarnessFixture;
let resumePaused: Array<() => void>;

beforeEach(async () => {
  spawnMock.mockClear();
  runUninstallScriptsMock.mockClear();
  runSetupScriptsMock.mockClear();
  removePluginsDirMock.mockClear();
  deleteCredentialMock.mockClear();
  resumePaused = [];
  h = await createCommandHarness();
  harness = await createHarnessFixture();
});

afterEach(async () => {
  for (const resume of resumePaused) {
    resume();
  }
  await h.dispose();
  await harness.dispose();
});

async function plantStopRequest(): Promise<string> {
  // A stop request of another, dead command: the file format with a pid of a process that is not there (999999999 is
  // above macOS's pid range).
  const path = join(h.home.dir, `${basename(queuePaths(h.home.statePath).stopRequestPrefix)}deadbeef`);
  await writeFile(path, '999999999\n', { mode: 0o600 });
  return path;
}

const SETUP_ARGS = ['--provider', 'feishu-signature', '--no-hooks', '--skip-login'];

describe('uninstall --all', () => {
  it('stops a worker busy in a follow-up item, removes the planted requests and the state, and keeps the lock and epoch', async () => {
    // The worker picks the owed refresh first, so it is busy in the follow-up lane when the records are still pending.
    await writeState(h.home.statePath, {
      sessions: {},
      queueOwed: { usageRefresh: [{ source: 'codex', scanEnv: {}, boundaryAt: T0, generation: 1 }] }
    });
    // Every worker delay waits for the gate: with the refresh held in its lane, the worker freezes at the end of its
    // first iteration, before any batch can list the records the test writes next.
    let releaseWorker: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    resumePaused.push(releaseWorker);
    const gatedDelay: Delay = (ms, signal) => gate.then(() => h.vt.delay(ms, signal));
    const hold = h.fake.holdRefreshes();
    const running = h.pool.start(1, { idleMs: 300_000, delay: gatedDelay });
    const busyWith = await hold.started;
    await plantStopRequest();
    await recordAt(h.home.statePath, T0, eventBody('SessionStart', 's1'));
    await recordAt(h.home.statePath, T0 + 1_000, eventBody('SessionStart', 's2'));
    expect(await readWorkerVersion(h.home.statePath)).toBe(1);
    expect((await listQueue(h.home.statePath)).records).toHaveLength(2);
    const starts = h.countingStarts();

    // Keep the command's retries and request touches paused with the worker while inspecting the tombstone.
    const removing = uninstall(
      ['--all'],
      h.takeoverOptions({ startWorker: starts.startWorker, delay: gatedDelay }),
      harness.layer
    );
    try {
      // The tombstone is already down while uninstall waits for the worker's lock.
      await until(async () => (await h.requestFiles()).length === 2, 'the live and the planted stop request');
      expect(await produceRecord(h.home.statePath, eventBody('SessionStart', 'late'), { clock: h.vt.clock })).toEqual({
        status: 'disabled'
      });
    } finally {
      releaseWorker();
      await removing;
    }
    await h.pool.settled();

    expect(await running).toBe('tombstone');
    expect(busyWith.source).toBe('codex');
    expect(starts.count()).toBe(0);
    await expect(stat(queuePaths(h.home.statePath).queueDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await h.requestFiles()).toEqual([]);
    expect(await readWorkerVersion(h.home.statePath)).toBe(0);
    await expect(stat(h.home.statePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fileExists(queuePaths(h.home.statePath).workerLock)).toBe(true);
    expect(await readEpoch(h.home.statePath)).toBe(0);
    expect(await isDisabled(h.home.statePath)).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();

    // A hook afterwards records nothing.
    expect(await produceRecord(h.home.statePath, eventBody('SessionStart', 'late'), { clock: h.vt.clock })).toEqual({
      status: 'disabled'
    });
    expect((await listQueue(h.home.statePath)).records).toEqual([]);
  });
});

describe('setup after a tombstone', () => {
  it('after uninstall --all it empties the queue, raises the epoch, and records apply again', async () => {
    await recordAt(h.home.statePath, T0, eventBody('SessionStart', 'gone'), { epoch: 0 });
    await uninstall(['--all'], h.takeoverOptions(), harness.layer);

    // A producer that passed its tombstone check just before the uninstall still wrote one record.
    await recordAt(h.home.statePath, T0 + 1_000, eventBody('SessionStart', 'raced'), { epoch: 0 });
    const starts = h.countingStarts();

    await setup(SETUP_ARGS, h.takeoverOptions({ startWorker: starts.startWorker }));

    expect(await readEpoch(h.home.statePath)).toBe(1);
    expect(await isDisabled(h.home.statePath)).toBe(false);
    expect((await listQueue(h.home.statePath)).records).toEqual([]);
    expect(starts.count()).toBe(0);

    // A producer that still writes the old epoch has its record deleted unapplied.
    await recordAt(h.home.statePath, T0 + 2_000, eventBody('SessionStart', 'stale'), { epoch: 0 });
    expect(await h.pool.start()).toBe('idle');
    const emptied = await readState(h.home.statePath);
    expect(emptied.sessions.stale).toBeUndefined();
    expect(emptied.sessions.raced).toBeUndefined();
    expect((await listQueue(h.home.statePath)).records).toEqual([]);

    // A produced record of the new epoch applies.
    const produced = await produceRecord(h.home.statePath, eventBody('SessionStart', 'fresh'), { clock: h.vt.clock });
    expect(produced).toMatchObject({ status: 'recorded', startWorker: true });
    void h.pool.start();
    await h.pool.settled();
    expect((await readState(h.home.statePath)).sessions.fresh).toMatchObject({ status: 'running' });
  });

  it('after worker --stop it raises the epoch and lets records apply again', async () => {
    await recordAt(h.home.statePath, T0, eventBody('SessionStart', 's1'));
    await stopWorker(h.home.statePath, h.takeoverOptions());
    expect(await isDisabled(h.home.statePath)).toBe(true);
    expect((await readState(h.home.statePath)).sessions.s1).toBeDefined();

    await setup(SETUP_ARGS, h.takeoverOptions());

    expect(await readEpoch(h.home.statePath)).toBe(1);
    expect(await isDisabled(h.home.statePath)).toBe(false);
    expect((await listQueue(h.home.statePath)).records).toEqual([]);

    const produced = await produceRecord(h.home.statePath, eventBody('SessionStart', 's2'), { clock: h.vt.clock });
    expect(produced).toMatchObject({ status: 'recorded', startWorker: true });
    void h.pool.start();
    await h.pool.settled();
    expect((await readState(h.home.statePath)).sessions.s2).toMatchObject({ status: 'running' });
  });

  it('without a tombstone it leaves pending records alone', async () => {
    await recordAt(h.home.statePath, T0, eventBody('SessionStart', 's1'));
    const starts = h.countingStarts();

    await setup(SETUP_ARGS, h.takeoverOptions({ startWorker: starts.startWorker }));

    expect(await isDisabled(h.home.statePath)).toBe(false);
    expect(await readEpoch(h.home.statePath)).toBe(0);
    expect((await listQueue(h.home.statePath)).records).toHaveLength(1);
    expect((await readState(h.home.statePath)).sessions.s1).toBeUndefined();
    expect(starts.count()).toBe(0);
  });
});

describe('downgrade between queue releases', () => {
  it('after the newer release stops the worker, the older release records nothing until its setup runs', async () => {
    await recordAt(h.home.statePath, T0, eventBody('SessionStart', 's1'), { version: NEWER });
    const starts = h.countingStarts();
    await stopWorker(h.home.statePath, h.takeoverOptions({ version: NEWER, startWorker: starts.startWorker }));
    expect(await isDisabled(h.home.statePath)).toBe(true);
    expect((await readState(h.home.statePath)).sessions.s1).toBeDefined();
    expect(starts.count()).toBe(0);

    // A producer of the older release records nothing and starts no worker.
    expect(
      await produceRecord(h.home.statePath, eventBody('SessionStart', 'o1'), {
        version: OLDER,
        clock: h.vt.clock
      })
    ).toEqual({ status: 'disabled' });
    expect(starts.count()).toBe(0);

    // A record the older producer raced in with, before the tombstone, waits in the queue.
    await recordAt(h.home.statePath, T0 + 1_000, eventBody('SessionStart', 'raced'), {
      version: OLDER,
      epoch: 0
    });

    // The older release's setup deletes the tombstone and the records left behind.
    await setup(SETUP_ARGS, h.takeoverOptions({ version: OLDER }));
    expect(await isDisabled(h.home.statePath)).toBe(false);
    expect(await readEpoch(h.home.statePath)).toBe(1);
    expect((await listQueue(h.home.statePath)).records).toEqual([]);

    // And its records apply again.
    const produced = await produceRecord(h.home.statePath, eventBody('SessionStart', 'o2'), {
      version: OLDER,
      clock: h.vt.clock
    });
    expect(produced).toMatchObject({ status: 'recorded', startWorker: true });
    void h.pool.start(OLDER);
    await h.pool.settled();
    expect((await readState(h.home.statePath)).sessions.o2).toMatchObject({ status: 'running' });
    expect((await readState(h.home.statePath)).sessions.raced).toBeUndefined();
  });
});
