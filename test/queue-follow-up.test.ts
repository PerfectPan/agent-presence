import { readFile, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { loadConfig, type AppConfig } from '../src/config.js';
import { scheduleDeferredRenderedUpdate } from '../src/cli/deferred-update.js';
import { acquireLock } from '../src/process-lock.js';
import { applyQueueBatch } from '../src/queue/apply.js';
import {
  createOwedAttempts,
  defaultOwedWorkEffects,
  knownSources,
  scanEnvironmentFor,
  workOffOwedItem,
  type OwedWorkEffects
} from '../src/queue/follow-up.js';
import { doableOwedItems, type OwedItem } from '../src/queue/owed.js';
import type { UsageRefreshEntry } from '../src/queue/schema.js';
import { readUsageEvents } from '../src/usage-events-log.js';
import {
  createQueueHome,
  dshUsage,
  eventBody,
  fakeEffects,
  readRawState,
  readState,
  recordAt,
  T0,
  until,
  writeState,
  type QueueHome
} from './queue-support.js';

// The rendered sync schedules a deferred flush as a detached process; record it instead.
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

const collectWindowUsageMock = vi.hoisted(() => vi.fn());

// The default effects' refresh scans for real; the scan is stood in for so a test reaches no transcript root outside
// its own home, while the env, signal and onSave the refresh passes on stay the ones under test.
vi.mock('../src/usage/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/usage/index.js')>()),
  collectWindowUsage: collectWindowUsageMock
}));

let home: QueueHome;
let now = T0;
const clock = { now: () => now };

/** Real milliseconds, for waits that must let file I/O and child processes finish while fake timers are installed. */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => realSetTimeout(resolve, ms));

beforeEach(async () => {
  home = await createQueueHome();
  now = T0 + 10 * 60_000;
  spawnMock.mockClear();
  collectWindowUsageMock.mockReset();
});

/**
 * `AbortSignal.timeout` on the fake clock: the native timer behind it cannot be faked, so tests that must tell a wait
 * from a give-up stand in for it (only `setTimeout` is faked; the watched work reaches its file I/O through real
 * event-loop turns).
 */
function timeoutOnFakeClock(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error(`timed out after ${ms}ms`)), ms);
  return controller.signal;
}

afterEach(async () => {
  await home.dispose();
});

async function nextItem(kind: OwedItem['kind']): Promise<OwedItem> {
  const state = await readState(home.statePath);
  const item = doableOwedItems(state.queueOwed, knownSources(await loadConfig())).find(
    (candidate) => candidate.kind === kind
  );
  if (!item) {
    throw new Error(`no owed ${kind}`);
  }
  return item;
}

async function workOff(item: OwedItem, effects: OwedWorkEffects, signal = new AbortController().signal) {
  return workOffOwedItem(item, { statePath: home.statePath, config: await loadConfig(), clock, effects, signal });
}

async function applyRecords(): Promise<void> {
  await applyQueueBatch(home.statePath, { version: 1, config: await loadConfig(), clock });
}

async function usageLines(): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(home.usageEventsPath, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('owed dsh usage', () => {
  it('appends the usage as parsed, with the record id, and then removes the entry', async () => {
    const usage = { ...dshUsage, costUsd: 0.25 };
    const id = await recordAt(home.statePath, T0, eventBody('Heartbeat', 'd1', { source: 'dsh', usage }));
    await applyRecords();
    const fake = fakeEffects();

    expect(await workOff(await nextItem('dshUsage'), fake.effects)).toBe('done');

    expect(await usageLines()).toEqual([{ ...usage, id }]);
    expect((await readState(home.statePath)).queueOwed?.dshUsage).toEqual([]);
  });

  it('waits while another writer holds the usage log, through its compaction, and then writes the line once', async () => {
    const id = await recordAt(home.statePath, T0, eventBody('Heartbeat', 'd1', { source: 'dsh', usage: dshUsage }));
    await applyRecords();
    const fake = fakeEffects();
    // The production append: while the lane's signal is live it waits for the lock instead of the 2.5 s default.
    const effects: OwedWorkEffects = { ...fake.effects, appendUsage: defaultOwedWorkEffects.appendUsage };
    const writer = await acquireLock(`${home.usageEventsPath}.lock.db`, AbortSignal.timeout(5_000));
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(timeoutOnFakeClock);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let settled = false;
      const appending = workOff(await nextItem('dshUsage'), effects).finally(() => {
        settled = true;
      });
      // The other writer appends past the size bound and compacts the file, all while holding the lock.
      await writeFile(home.usageEventsPath, `${JSON.stringify({ ...dshUsage, id: 'other' })}\n`.repeat(10));
      await truncate(home.usageEventsPath, 0);
      // Longer than the 2.5 s default bound: the append waits for the lock however long the writer holds it.
      await vi.advanceTimersByTimeAsync(3_000);
      expect(settled).toBe(false);
      expect(timeoutSpy).not.toHaveBeenCalled();
      expect(await usageLines()).toEqual([]);
      await writer.release();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(await appending).toBe('done');
      expect(await usageLines()).toEqual([{ ...dshUsage, id }]);
      expect(await readUsageEvents('dsh', 0, T0 + 1)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      await writer.release().catch(() => undefined);
    }
  });

  it('stays owed when its wait for the usage log is aborted', async () => {
    await recordAt(home.statePath, T0, eventBody('Heartbeat', 'd1', { source: 'dsh', usage: dshUsage }));
    await applyRecords();
    const writer = await acquireLock(`${home.usageEventsPath}.lock.db`, AbortSignal.timeout(5_000));
    const controller = new AbortController();

    const appending = workOff(await nextItem('dshUsage'), fakeEffects().effects, controller.signal);
    controller.abort();

    expect(await appending).toBe('aborted');
    await writer.release();
    expect((await readState(home.statePath)).queueOwed?.dshUsage).toHaveLength(1);
    expect(await usageLines()).toEqual([]);
  });

  it('counts a line repeated by an applier that died before removing the entry once', async () => {
    const id = await recordAt(home.statePath, T0, eventBody('Heartbeat', 'd1', { source: 'dsh', usage: dshUsage }));
    await applyRecords();
    const item = await nextItem('dshUsage');
    // The first applier wrote the line and died before its save.
    const fake = fakeEffects();
    await fake.effects.appendUsage(dshUsage, id, new AbortController().signal);

    expect(await workOff(item, fake.effects)).toBe('done');

    expect(await usageLines()).toHaveLength(2);
    expect(await readUsageEvents('dsh', 0, T0 + 1)).toHaveLength(1);
  });
});

describe('owed usage refresh', () => {
  async function owedClaudeRefresh(): Promise<void> {
    await recordAt(
      home.statePath,
      T0,
      eventBody('SessionStart', 'c1', { source: 'claude', scanEnv: { CLAUDE_CONFIG_DIR: '/fake-home/a' } })
    );
    await applyRecords();
  }

  it('refreshes the source at its boundary time and removes the entry in the refresh save, owing a sync', async () => {
    await owedClaudeRefresh();
    await writeState(home.statePath, {
      ...(await readRawState(home.statePath)),
      queueOwed: {
        usageRefresh: (await readState(home.statePath)).queueOwed?.usageRefresh
      }
    });
    const fake = fakeEffects();

    expect(await workOff(await nextItem('usageRefresh'), fake.effects)).toBe('done');

    expect(fake.refreshed).toHaveLength(1);
    expect(fake.refreshed[0]).toMatchObject({ source: 'claude', boundaryAt: T0 });
    expect(fake.refreshed[0]?.env.CLAUDE_CONFIG_DIR).toBe('/fake-home/a');
    expect((await readRawState(home.statePath)).queueOwed).toEqual({ usageRefresh: [], renderedSync: true });
  });

  it('keeps the refresh owed when a boundary of its source arrives while it scans', async () => {
    await owedClaudeRefresh();
    const fake = fakeEffects();
    const gate = fake.holdRefreshes();

    const refreshing = workOff(await nextItem('usageRefresh'), fake.effects);
    await gate.started;
    await recordAt(
      home.statePath,
      T0 + 1_000,
      eventBody('Stop', 'c1', { source: 'claude', scanEnv: { CLAUDE_CONFIG_DIR: '/fake-home/a' } })
    );
    await applyRecords();
    gate.release();

    expect(await refreshing).toBe('done');
    expect((await readState(home.statePath)).queueOwed?.usageRefresh).toEqual([
      { source: 'claude', scanEnv: { CLAUDE_CONFIG_DIR: '/fake-home/a' }, boundaryAt: T0 + 1_000, generation: 2 }
    ]);
  });

  it('removes an entry whose refresh completed without saving, owing no sync', async () => {
    await owedClaudeRefresh();
    await writeState(home.statePath, {
      ...(await readRawState(home.statePath)),
      queueOwed: { usageRefresh: (await readState(home.statePath)).queueOwed?.usageRefresh }
    });
    const effects: OwedWorkEffects = { ...fakeEffects().effects, refreshUsage: async () => ({ completed: true }) };

    expect(await workOff(await nextItem('usageRefresh'), effects)).toBe('done');

    expect((await readRawState(home.statePath)).queueOwed).toEqual({ usageRefresh: [] });
  });

  it('stays owed when the refresh is aborted', async () => {
    await owedClaudeRefresh();
    const fake = fakeEffects();
    const gate = fake.holdRefreshes();
    const controller = new AbortController();

    const refreshing = workOff(await nextItem('usageRefresh'), fake.effects, controller.signal);
    await gate.started;
    controller.abort();

    expect(await refreshing).toBe('aborted');
    expect((await readState(home.statePath)).queueOwed?.usageRefresh).toHaveLength(1);
  });

  it('lists only refreshes of sources in the merged source table as work it can do', async () => {
    const config: AppConfig = { plugins: { sources: { mine: { match: {} }, codex: { enabled: false } } } };
    const entry = (source: string): UsageRefreshEntry => ({ source, scanEnv: {}, boundaryAt: T0, generation: 1 });

    const items = doableOwedItems(
      { usageRefresh: [entry('grok'), entry('later-agent'), entry('mine'), entry('codex')], laterKind: [1] },
      knownSources(config)
    );

    expect(items.map((item) => (item.kind === 'usageRefresh' ? item.entry.source : item.kind))).toEqual([
      'grok',
      'mine'
    ]);
  });
});

describe('scanEnvironmentFor', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('takes the transcript roots of the entry source from the entry and keeps the rest of the worker environment', () => {
    process.env.CLAUDE_CONFIG_DIR = '/fake-home/worker-claude';
    process.env.GEMINI_CLI_HOME = '/fake-home/worker-gemini';
    const entry = (scanEnv: UsageRefreshEntry['scanEnv']): UsageRefreshEntry => ({
      source: 'claude',
      scanEnv,
      boundaryAt: T0,
      generation: 1
    });

    expect(scanEnvironmentFor(entry({ CLAUDE_CONFIG_DIR: '/fake-home/hook-claude' }))).toMatchObject({
      CLAUDE_CONFIG_DIR: '/fake-home/hook-claude',
      GEMINI_CLI_HOME: '/fake-home/worker-gemini'
    });
    // The hook ran without the variable, so its agent uses the default root, whatever the worker has.
    expect(scanEnvironmentFor(entry({})).CLAUDE_CONFIG_DIR).toBeUndefined();
    // A variable another source reads, recorded with the entry, is taken from the entry too.
    expect(scanEnvironmentFor(entry({ GEMINI_CLI_HOME: '/fake-home/hook-gemini' })).GEMINI_CLI_HOME).toBe(
      '/fake-home/hook-gemini'
    );
  });
});

describe('owed rendered sync', () => {
  async function owedSync(): Promise<void> {
    await home.writeConfig({ provider: 'feishu-signature', render: { zero: 'idle', one: '{count} running' } });
    await recordAt(home.statePath, now - 1_000, eventBody('SessionStart', 's1'));
    await applyRecords();
  }

  it('publishes the rendered value and settles the sync in the save that records the publish', async () => {
    await owedSync();
    const fake = fakeEffects();

    expect(await workOff(await nextItem('renderedSync'), fake.effects)).toBe('done');

    expect(fake.published).toHaveLength(1);
    const state = await readState(home.statePath);
    expect(state.lastValue).toBe(fake.published[0]);
    expect(state.queueOwed?.renderedSync).toBeUndefined();
  });

  it('keeps the sync owed and the interval unclaimed when the publish fails', async () => {
    await owedSync();
    const fake = fakeEffects();
    fake.failPublishes();

    expect(await workOff(await nextItem('renderedSync'), fake.effects)).toBe('failed');

    const state = await readState(home.statePath);
    expect(state.queueOwed?.renderedSync).toBe(true);
    expect(state.lastSlotUpdateAt).toBe(0);
  });

  it('keeps the sync owed when the publish is aborted', async () => {
    await owedSync();
    const fake = fakeEffects();
    const gate = fake.holdPublishes();
    const controller = new AbortController();

    const syncing = workOff(await nextItem('renderedSync'), fake.effects, controller.signal);
    await gate.started;
    controller.abort();

    expect(await syncing).toBe('aborted');
    expect((await readState(home.statePath)).queueOwed?.renderedSync).toBe(true);
  });

  it('counts a publish that the provider timeout aborts as a failed attempt', async () => {
    await owedSync();
    const saved = { token: process.env.AGENT_PRESENCE_TOKEN, slotId: process.env.AGENT_PRESENCE_SLOT_ID };
    process.env.AGENT_PRESENCE_TOKEN = 'token_test';
    process.env.AGENT_PRESENCE_SLOT_ID = 'slot_test';
    process.env.AGENT_PRESENCE_LOG_FILE = join(home.dir, 'agent-presence.log');
    // The provider hangs forever; the native timer behind `AbortSignal.timeout` cannot be faked, so the test
    // stands in for it on the fake clock and still pins the 30-second timeout the publish asked for. Only
    // `setTimeout` is faked: the chain reaches the fetch through file I/O, which needs real event-loop turns.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const timeoutSignal = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error(`publish timed out after ${ms}ms`)), ms);
      return controller.signal;
    });
    const fetchMock = vi.fn<(url: unknown, init: { signal?: AbortSignal }) => Promise<never>>(
      (_url, init) =>
        new Promise<never>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    try {
      // The real publish chain: credential, provider, fetch. It reaches the fetch through real file I/O and the kit's
      // identity read, which a busy machine can delay, so the wait is in real time and bounded, never on the clock.
      const syncing = workOffOwedItem(await nextItem('renderedSync'), {
        statePath: home.statePath,
        config: await loadConfig(),
        clock,
        effects: defaultOwedWorkEffects,
        signal: new AbortController().signal
      }).then(
        (ended) => ended,
        (error: unknown) => error
      );
      for (let waited = 0; waited < 30_000 && fetchMock.mock.calls.length === 0; waited += 100) {
        await realSleep(100);
      }
      expect(fetchMock.mock.calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(30_000);

      expect(await syncing).toBe('failed');
      expect(timeoutSignal).toHaveBeenCalledWith(30_000);
      const state = await readState(home.statePath);
      expect(state.queueOwed?.renderedSync).toBe(true);
      expect(state.lastSlotUpdateAt).toBe(0);
      // Run every timer the call left on the fake clock, so nothing rejects after the test is over.
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
      vi.restoreAllMocks();
      if (saved.token === undefined) {
        delete process.env.AGENT_PRESENCE_TOKEN;
      } else {
        process.env.AGENT_PRESENCE_TOKEN = saved.token;
      }
      if (saved.slotId === undefined) {
        delete process.env.AGENT_PRESENCE_SLOT_ID;
      } else {
        process.env.AGENT_PRESENCE_SLOT_ID = saved.slotId;
      }
      delete process.env.AGENT_PRESENCE_LOG_FILE;
    }
  });

  it('keeps the sync owed when records applied during the publish render another value', async () => {
    await owedSync();
    const effects: OwedWorkEffects = {
      ...fakeEffects().effects,
      publish: async () => {
        await recordAt(home.statePath, now - 500, eventBody('SessionStart', 's2'));
        await applyRecords();
      }
    };

    expect(await workOff(await nextItem('renderedSync'), effects)).toBe('done');

    expect((await readState(home.statePath)).queueOwed?.renderedSync).toBe(true);
  });

  it('settles the sync when records applied during the publish render the same value', async () => {
    await owedSync();
    const effects: OwedWorkEffects = {
      ...fakeEffects().effects,
      publish: async () => {
        await recordAt(home.statePath, now - 500, eventBody('Heartbeat', 's1'));
        await applyRecords();
      }
    };

    expect(await workOff(await nextItem('renderedSync'), effects)).toBe('done');

    expect((await readState(home.statePath)).queueOwed?.renderedSync).toBeUndefined();
  });

  it('settles the sync when it schedules the deferred flush inside the debounce interval', async () => {
    await owedSync();
    await writeState(home.statePath, { ...(await readRawState(home.statePath)), lastSlotUpdateAt: now - 1_000 });
    const fake = fakeEffects();

    expect(await workOff(await nextItem('renderedSync'), fake.effects)).toBe('done');

    expect(fake.published).toEqual([]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const state = await readState(home.statePath);
    expect(state.pendingSlotFlushAt).toBe(now + 60_000);
    expect(state.queueOwed?.renderedSync).toBeUndefined();
  });

  it('settles the sync when the state renders the value already published', async () => {
    await owedSync();
    const fake = fakeEffects();
    await workOff(await nextItem('renderedSync'), fake.effects);
    await writeState(home.statePath, {
      ...(await readRawState(home.statePath)),
      queueOwed: { renderedSync: true }
    });

    expect(await workOff(await nextItem('renderedSync'), fake.effects)).toBe('done');

    expect(fake.published).toHaveLength(1);
    expect((await readState(home.statePath)).queueOwed?.renderedSync).toBeUndefined();
  });
});

describe('scheduleDeferredRenderedUpdate', () => {
  it('settles the owed sync when a deferred flush is already scheduled in range, and spawns none', async () => {
    await writeState(home.statePath, {
      sessions: {},
      pendingSlotFlushAt: now + 30_000,
      queueOwed: { renderedSync: true, dshUsage: [{ id: 'r1', usage: dshUsage }] }
    });

    await scheduleDeferredRenderedUpdate({ statePath: home.statePath, delayMs: 60_000, now });

    expect(spawnMock).not.toHaveBeenCalled();
    const raw = await readRawState(home.statePath);
    expect(raw.pendingSlotFlushAt).toBe(now + 30_000);
    // The sync is settled, so the follow-up lane does not run it again while the flush is already in range, and the
    // other owed work stays.
    expect(raw.queueOwed).toEqual({ dshUsage: [{ id: 'r1', usage: dshUsage }] });
  });
});

describe('defaultOwedWorkEffects', () => {
  it('append waits for the usage log lock while the lane signal is live, past the default bound, and writes once it holds the lock', async () => {
    const writer = await acquireLock(`${home.usageEventsPath}.lock.db`, AbortSignal.timeout(5_000));
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(timeoutOnFakeClock);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let settled = false;
      const appending = defaultOwedWorkEffects.appendUsage(dshUsage, 'r1', new AbortController().signal).then(
        (written) => {
          settled = true;
          return written;
        }
      );
      // Longer than the 2.5 s default bound: with the lane's signal, the wait does not give up.
      await vi.advanceTimersByTimeAsync(3_000);
      expect(settled).toBe(false);
      expect(timeoutSpy).not.toHaveBeenCalled();
      expect(await usageLines()).toEqual([]);
      await writer.release();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(await appending).toBe(true);
      expect(await usageLines()).toEqual([{ ...dshUsage, id: 'r1' }]);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      await writer.release().catch(() => undefined);
    }
  });

  it('append stops on the lane signal while it waits for the usage log lock, and writes nothing', async () => {
    const writer = await acquireLock(`${home.usageEventsPath}.lock.db`, AbortSignal.timeout(5_000));
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(timeoutOnFakeClock);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const controller = new AbortController();
      const appending = defaultOwedWorkEffects.appendUsage(dshUsage, 'r1', controller.signal);
      await vi.advanceTimersByTimeAsync(100);
      controller.abort();

      expect(await appending).toBe(false);
      expect(await usageLines()).toEqual([]);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      await writer.release().catch(() => undefined);
    }
  });

  it('refresh scans with the item scan environment and saves through onSave', async () => {
    await recordAt(
      home.statePath,
      T0,
      eventBody('SessionStart', 'c1', { source: 'claude', scanEnv: { CLAUDE_CONFIG_DIR: '/fake-home/a' } })
    );
    await applyRecords();
    collectWindowUsageMock.mockResolvedValue({ bySource: [{ source: 'claude', totalTokens: 500, costUsd: 0.5 }] });

    expect(await workOff(await nextItem('usageRefresh'), defaultOwedWorkEffects)).toBe('done');

    const scan = collectWindowUsageMock.mock.calls[0]?.[0] as {
      env: Record<string, string | undefined>;
      now: number;
    };
    expect(scan.env.CLAUDE_CONFIG_DIR).toBe('/fake-home/a');
    expect(scan.now).toBe(T0);
    const raw = await readRawState(home.statePath);
    expect(raw.usageSnapshots).toMatchObject({ '1': { claude: { totalTokens: 500 } } });
    // The entry's removal and the owed sync were saved through onSave, in the refresh's own save.
    expect(raw.queueOwed).toEqual({ usageRefresh: [], renderedSync: true });
  });

  it('refresh stops on the lane signal', async () => {
    await recordAt(
      home.statePath,
      T0,
      eventBody('SessionStart', 'c1', { source: 'claude', scanEnv: { CLAUDE_CONFIG_DIR: '/fake-home/a' } })
    );
    await applyRecords();
    const controller = new AbortController();
    controller.abort();

    expect(await workOff(await nextItem('usageRefresh'), defaultOwedWorkEffects, controller.signal)).toBe('aborted');

    expect(collectWindowUsageMock).not.toHaveBeenCalled();
    expect((await readState(home.statePath)).queueOwed?.usageRefresh).toHaveLength(1);
  });

  it('publish gets the lane signal: the provider request ends when the lane aborts', async () => {
    const saved = { token: process.env.AGENT_PRESENCE_TOKEN, slotId: process.env.AGENT_PRESENCE_SLOT_ID };
    process.env.AGENT_PRESENCE_TOKEN = 'token_test';
    process.env.AGENT_PRESENCE_SLOT_ID = 'slot_test';
    process.env.AGENT_PRESENCE_LOG_FILE = join(home.dir, 'agent-presence.log');
    const fetchMock = vi.fn<(url: unknown, init: { signal?: AbortSignal }) => Promise<never>>(
      (_url, init) =>
        new Promise<never>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    try {
      const controller = new AbortController();
      const publishing = defaultOwedWorkEffects.publish('idle', await loadConfig(), controller.signal).then(
        () => 'published' as const,
        (error: unknown) => error
      );
      // The chain reaches the fetch through file I/O, which needs real event-loop turns; the wait is bounded, never
      // on the clock.
      for (let waited = 0; waited < 30_000 && fetchMock.mock.calls.length === 0; waited += 100) {
        await realSleep(100);
      }
      expect(fetchMock.mock.calls).toHaveLength(1);
      const init = fetchMock.mock.calls[0]?.[1] as { signal?: AbortSignal };
      expect(init.signal?.aborted).toBe(false);

      controller.abort();

      const ended = (await publishing) as Error;
      expect(init.signal?.aborted).toBe(true);
      expect(ended.name).toBe('AbortError');
      // The request's diagnostic line is written without being awaited; let it land before the home goes away.
      await until(
        () =>
          readFile(join(home.dir, 'agent-presence.log'), 'utf8').then(
            (text) => text.includes('type=provider.request'),
            () => false
          ),
        'the provider request line'
      );
    } finally {
      vi.unstubAllGlobals();
      if (saved.token === undefined) {
        delete process.env.AGENT_PRESENCE_TOKEN;
      } else {
        process.env.AGENT_PRESENCE_TOKEN = saved.token;
      }
      if (saved.slotId === undefined) {
        delete process.env.AGENT_PRESENCE_SLOT_ID;
      } else {
        process.env.AGENT_PRESENCE_SLOT_ID = saved.slotId;
      }
      delete process.env.AGENT_PRESENCE_LOG_FILE;
    }
  });
});

describe('createOwedAttempts', () => {
  const sources = new Set(['claude']);
  const refresh = (generation: number): UsageRefreshEntry => ({
    source: 'claude',
    scanEnv: { CLAUDE_CONFIG_DIR: '/fake-home/a' },
    boundaryAt: T0,
    generation
  });

  it('does not offer an item it set aside again until new work for it is owed', () => {
    const attempts = createOwedAttempts();
    const state = (generation: number) => ({
      sessions: {},
      queueOwed: { dshUsage: [{ id: 'r1', usage: dshUsage }], usageRefresh: [refresh(generation)], renderedSync: true }
    });

    const dsh = attempts.next(state(1), sources);
    expect(dsh?.kind).toBe('dshUsage');
    if (dsh) {
      attempts.setAside(dsh);
    }
    const first = attempts.next(state(1), sources);
    expect(first?.kind).toBe('usageRefresh');
    if (first) {
      attempts.setAside(first);
    }
    const sync = attempts.next(state(1), sources);
    expect(sync?.kind).toBe('renderedSync');
    if (sync) {
      attempts.setAside(sync);
    }
    expect(attempts.next(state(1), sources)).toBeUndefined();

    // A later boundary updated the refresh; an applied event owes a new sync.
    expect(attempts.next(state(2), sources)?.kind).toBe('usageRefresh');
    attempts.renderedSyncOwedAgain();
    expect(attempts.next(state(1), sources)?.kind).toBe('renderedSync');
    expect(attempts.next(state(1), sources, ['dshUsage'])).toBeUndefined();
  });
});
