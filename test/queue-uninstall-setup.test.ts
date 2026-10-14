import { readdir, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { setup } from '../src/cli/commands/setup.js';
import { uninstall } from '../src/cli/commands/uninstall.js';
import { fileExists, isDisabled, queuePaths, readEpoch, readWorkerVersion } from '../src/queue/files.js';
import { produceRecord } from '../src/queue/produce.js';
import { listQueue } from '../src/queue/reader.js';
import { stopWorker } from '../src/queue/takeover.js';
import { eventBody, readState, recordAt, T0 } from './queue-support.js';
import { createCommandHarness, type CommandHarness } from './queue-command-harness.js';

// Plan 0003 3.8: `uninstall --all` writes the tombstone, empties the queue under a takeover, and keeps the lock and
// the epoch; `setup` removes a tombstone, raises the epoch, and lets records apply again; without a tombstone it
// leaves the queue alone. The downgrade path of 3.12 runs the same setup of an older release through the seam.

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

beforeEach(async () => {
  spawnMock.mockClear();
  runUninstallScriptsMock.mockClear();
  runSetupScriptsMock.mockClear();
  removePluginsDirMock.mockClear();
  deleteCredentialMock.mockClear();
  h = await createCommandHarness();
});

afterEach(async () => {
  await h.dispose();
});

async function requestFiles(): Promise<string[]> {
  const prefix = basename(queuePaths(h.home.statePath).stopRequestPrefix);
  return (await readdir(h.home.dir)).filter((name) => name.startsWith(prefix));
}

const SETUP_ARGS = ['--provider', 'feishu-signature', '--no-hooks', '--skip-login'];

describe('uninstall --all (Spec S10)', () => {
  it('stops the worker, removes the queue, the requests, the worker version and the state, and keeps the lock and epoch', async () => {
    await recordAt(h.home.statePath, T0, eventBody('SessionStart', 's1'));
    const running = h.pool.start(1, { idleMs: 300_000 });
    await vi.waitFor(async () => expect(await readWorkerVersion(h.home.statePath)).toBe(1));
    const starts = h.countingStarts();

    await uninstall(['--all'], h.takeoverOptions({ startWorker: starts.startWorker }));
    await h.pool.settled();

    expect(['tombstone', 'stop-request']).toContain(await running);
    expect(starts.count()).toBe(0);
    await expect(stat(queuePaths(h.home.statePath).queueDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await requestFiles()).toEqual([]);
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
    await uninstall(['--all'], h.takeoverOptions());

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

describe('downgrade between queue releases (3.12)', () => {
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
