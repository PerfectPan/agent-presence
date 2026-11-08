import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAgentEvent } from '../src/state.js';
import { SlotRateLimitError } from '../src/render.js';
import { syncExplicitSlotValueWithStateLock, syncRenderedSlotWithStateLock } from '../src/cli/slot-sync.js';

let tempDir: string | undefined;

afterEach(async () => {
  delete process.env.AGENT_PRESENCE_LOG_FILE;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

async function useTempFiles(): Promise<{ logPath: string; statePath: string }> {
  tempDir = await mkdtemp(join(tmpdir(), 'agent-presence-update-test-'));
  const logPath = join(tempDir, 'agent-presence.log');
  process.env.AGENT_PRESENCE_LOG_FILE = logPath;
  return {
    logPath,
    statePath: join(tempDir, 'state.json')
  };
}

function coerceLogValue(value: string): unknown {
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value) as string;
  }
  return value;
}

function parseLogLine(line: string): Record<string, unknown> {
  const fields = Object.fromEntries(
    line.split(' ').map((part) => {
      const separator = part.indexOf('=');
      const key = part.slice(0, separator);
      const rawValue = part.slice(separator + 1);
      return [key, coerceLogValue(rawValue)];
    })
  );
  return fields;
}

async function waitForLogEvents(path: string, count: number): Promise<Array<Record<string, unknown>>> {
  await expect
    .poll(async () => {
      try {
        return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).length;
      } catch {
        return 0;
      }
    })
    .toBe(count);
  return (await readFile(path, 'utf8')).trim().split('\n').map(parseLogLine);
}

describe('slot sync debounce', () => {
  it('logs each slot update attempt and result without leaking the rendered value', async () => {
    const { logPath, statePath } = await useTempFiles();
    const updateSlot = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined);

    await expect(
      syncExplicitSlotValueWithStateLock(
        statePath,
        {
          force: true,
          now: 62_000,
          debounceMs: 60_000,
          value: 'sensitive rendered value'
        },
        updateSlot
      )
    ).resolves.toEqual({ status: 'updated', value: 'sensitive rendered value' });

    const events = await waitForLogEvents(logPath, 2);
    expect(events.map((event) => event.result)).toEqual(['start', 'updated']);
    expect(events[0]).toMatchObject({
      app: 'agent-presence',
      type: 'slot.update',
      valueLength: 24,
      previousLastSlotUpdateAt: 0,
      claimedLastSlotUpdateAt: 62_000
    });
    expect(typeof events[0]?.pid).toBe('number');
    expect(JSON.stringify(events)).not.toContain('sensitive rendered value');
  });

  it('logs rate limited slot updates', async () => {
    const { logPath, statePath } = await useTempFiles();
    const updateSlot = vi
      .fn<(value: string) => Promise<void>>()
      .mockRejectedValue(new SlotRateLimitError('slot provider returned 429', 60_000));

    await expect(
      syncExplicitSlotValueWithStateLock(
        statePath,
        {
          force: true,
          now: 62_000,
          debounceMs: 60_000,
          value: 'value'
        },
        updateSlot
      )
    ).resolves.toEqual({ status: 'skipped', reason: 'rate-limited', value: 'value', retryAfterMs: 60_000 });

    const events = await waitForLogEvents(logPath, 2);
    expect(events.map((event) => event.result)).toEqual(['start', 'rate-limited']);
    expect(events[1]).toMatchObject({
      type: 'slot.update',
      valueLength: 5,
      retryAfterMs: 60_000
    });
  });

  it('persists local session state before provider IO and keeps it when provider IO fails', async () => {
    const { statePath } = await useTempFiles();
    const updateSlot = vi.fn<(value: string) => Promise<void>>().mockRejectedValue(new Error('provider unavailable'));

    await expect(
      syncRenderedSlotWithStateLock(
        statePath,
        {
          force: true,
          now: 62_000,
          debounceMs: 60_000,
          ttlMs: 180_000
        },
        updateSlot,
        (state) => {
          applyAgentEvent(state, {
            source: 'codex',
            event: 'UserPromptSubmit',
            sessionId: 'thread-1',
            now: 62_000,
            project: '/repo'
          });
        }
      )
    ).rejects.toThrow('provider unavailable');

    const persisted = JSON.parse(await readFile(statePath, 'utf8'));
    expect(persisted.sessions['thread-1']).toMatchObject({
      id: 'thread-1',
      source: 'codex',
      status: 'running',
      startedAt: 62_000,
      lastHeartbeatAt: 62_000,
      project: '/repo'
    });
    expect(persisted.lastSlotUpdateAt).toBe(0);
  });
});

describe('published usage metadata across state reloads', () => {
  const now = new Date(2026, 10, 7, 23, 50).getTime();
  const deadline = new Date(2026, 10, 8).getTime();
  const options = { force: true, now, debounceMs: 0, ttlMs: 60_000, usage: { enabled: true, defaultWindow: 1 } };

  it('roundtrips a rendered publish through load/save and clears the deadline on an explicit publish', async () => {
    const { statePath } = await useTempFiles();
    const { loadState, saveState } = await import('../src/state-store.js');
    await syncRenderedSlotWithStateLock(
      statePath,
      options,
      async () => undefined,
      (state) => {
        state.usageBadges = { '1': '2.1M' };
        state.usageBadgesAt = now;
      }
    );
    const loaded = await loadState(statePath);
    expect(loaded.usageResetDeadlineMs).toBe(deadline);
    expect(loaded.lastValue).toContain('2.1M');
    applyAgentEvent(loaded, { source: 'codex', event: 'SessionStart', sessionId: 's1', now });
    await saveState(loaded, statePath);
    expect((await loadState(statePath)).usageResetDeadlineMs).toBe(deadline);
    await syncExplicitSlotValueWithStateLock(
      statePath,
      { force: true, now: now + 1, debounceMs: 0, value: 'manual' },
      async () => undefined
    );
    expect(await loadState(statePath)).toMatchObject({ lastValue: 'manual', usageResetDeadlineMs: undefined });
  });

  it('retains the previous published deadline when the provider fails or rate limits', async () => {
    const { statePath } = await useTempFiles();
    const { loadState } = await import('../src/state-store.js');
    await syncRenderedSlotWithStateLock(
      statePath,
      options,
      async () => undefined,
      (state) => {
        state.usageBadges = { '1': '2.1M' };
        state.usageBadgesAt = now;
      }
    );
    const later = { ...options, now: new Date(2026, 10, 8, 23, 50).getTime() };
    await expect(
      syncRenderedSlotWithStateLock(
        statePath,
        later,
        async () => {
          throw new Error('failed');
        },
        (state) => {
          state.usageBadgesAt = later.now;
        }
      )
    ).rejects.toThrow('failed');
    expect((await loadState(statePath)).usageResetDeadlineMs).toBe(deadline);
    await syncRenderedSlotWithStateLock(statePath, later, async () => {
      throw new SlotRateLimitError();
    });
    expect((await loadState(statePath)).usageResetDeadlineMs).toBe(deadline);
  });

  it('publishes equal text again when a new day gives that text a different deadline', async () => {
    const { statePath } = await useTempFiles();
    const { loadState } = await import('../src/state-store.js');
    const publish = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined);
    await syncRenderedSlotWithStateLock(statePath, options, publish, (state) => {
      state.usageBadges = { '1': '0' };
      state.usageBadgesAt = now;
    });
    const later = { ...options, force: false, now: new Date(2026, 10, 8, 23, 50).getTime() };
    await syncRenderedSlotWithStateLock(statePath, later, publish, (state) => {
      state.usageBadgesAt = later.now;
    });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[0]).toEqual(publish.mock.calls[1]);
    expect((await loadState(statePath)).usageResetDeadlineMs).toBe(new Date(2026, 10, 9).getTime());
  });

  it('leaves a newer deadline owed when the cache changes during a publish with equal text', async () => {
    const { statePath } = await useTempFiles();
    const { loadState, saveState, withStateLock } = await import('../src/state-store.js');
    await syncRenderedSlotWithStateLock(
      statePath,
      options,
      async () => {
        await withStateLock(statePath, async () => {
          const state = await loadState(statePath);
          state.usageBadgesAt = new Date(2026, 10, 8, 23, 50).getTime();
          state.queueOwed = { ...state.queueOwed, renderedSync: true };
          await saveState(state, statePath);
        });
      },
      (state) => {
        state.usageBadges = { '1': '0' };
        state.usageBadgesAt = now;
        state.queueOwed = { renderedSync: true };
      }
    );
    const state = await loadState(statePath);
    expect(state.usageResetDeadlineMs).toBe(deadline);
    expect(state.queueOwed?.renderedSync).toBe(true);
  });
});
