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
