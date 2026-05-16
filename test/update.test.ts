import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmptyState, applyAgentEvent } from '../src/state.js';
import { markSlotSyncSuccess, prepareSlotSync, rollbackSlotSyncClaim, SlotRateLimitError, syncSlot } from '../src/render.js';
import { syncExplicitSlotValueWithStateLock, syncRenderedSlotWithStateLock } from '../src/cli/slot-sync.js';

let tempDir: string | undefined;

afterEach(async () => {
  delete process.env.AGENT_PRESENCE_LOG_FILE;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe('slot sync debounce', () => {
  it('updates when force is true even inside debounce window', async () => {
    const state = createEmptyState();
    state.lastSlotUpdateAt = 1778577015486;
    state.lastValue = 'AI 牛马暂未开工';
    applyAgentEvent(state, {
      source: 'codex',
      event: 'SessionStart',
      sessionId: 'thread-1',
      now: 1778577020000
    });
    const updateSlot = vi.fn().mockResolvedValue(undefined);

    const result = await syncSlot(state, {
      force: true,
      now: 1778577020000,
      debounceMs: 60_000,
      ttlMs: 180_000,
      updateSlot
    });

    expect(result).toEqual({ status: 'updated', value: '1 个 AI 牛马正在搬砖 | codex 1' });
    expect(updateSlot).toHaveBeenCalledWith('1 个 AI 牛马正在搬砖 | codex 1');
  });

  it('skips changed values inside the debounce window', async () => {
    const state = createEmptyState();
    state.lastSlotUpdateAt = 1778577015486;
    state.lastValue = 'AI 牛马暂未开工';
    applyAgentEvent(state, {
      source: 'codex',
      event: 'SessionStart',
      sessionId: 'thread-1',
      now: 1778577020000
    });
    const updateSlot = vi.fn().mockResolvedValue(undefined);

    const result = await syncSlot(state, {
      force: false,
      now: 1778577020000,
      debounceMs: 60_000,
      ttlMs: 180_000,
      updateSlot
    });

    expect(result).toEqual({
      status: 'skipped',
      reason: 'debounced',
      value: '1 个 AI 牛马正在搬砖 | codex 1'
    });
    expect(updateSlot).not.toHaveBeenCalled();
  });

  it('claims the debounce window before provider IO without marking the slot value as updated', () => {
    const state = createEmptyState();
    state.lastSlotUpdateAt = 1_000;
    state.lastValue = 'AI 牛马暂未开工';
    applyAgentEvent(state, {
      source: 'codex',
      event: 'SessionStart',
      sessionId: 'thread-1',
      now: 62_000
    });

    const decision = prepareSlotSync(state, {
      force: false,
      now: 62_000,
      debounceMs: 60_000,
      ttlMs: 180_000
    });

    expect(decision).toEqual({
      action: 'update',
      claimedLastSlotUpdateAt: 62_000,
      previousLastSlotUpdateAt: 1_000,
      value: '1 个 AI 牛马正在搬砖 | codex 1'
    });
    expect(state.lastSlotUpdateAt).toBe(62_000);
    expect(state.lastValue).toBe('AI 牛马暂未开工');

    markSlotSyncSuccess(state, decision);

    expect(state.lastSlotUpdateAt).toBe(62_000);
    expect(state.lastValue).toBe('1 个 AI 牛马正在搬砖 | codex 1');
  });

  it('rolls back a claimed debounce window when provider IO fails before another update claims it', () => {
    const state = createEmptyState();
    state.lastSlotUpdateAt = 1_000;
    applyAgentEvent(state, {
      source: 'codex',
      event: 'SessionStart',
      sessionId: 'thread-1',
      now: 62_000
    });

    const decision = prepareSlotSync(state, {
      force: false,
      now: 62_000,
      debounceMs: 60_000,
      ttlMs: 180_000
    });

    rollbackSlotSyncClaim(state, decision);

    expect(state.lastSlotUpdateAt).toBe(1_000);
    expect(state.lastValue).toBe('');
  });

  it('logs each slot update attempt and result without leaking the rendered value', async () => {
    const { logPath, statePath } = await useTempFiles();
    const updateSlot = vi.fn().mockResolvedValue(undefined);

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
    const updateSlot = vi.fn().mockRejectedValue(new SlotRateLimitError('slot provider returned 429', 60_000));

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
    const updateSlot = vi.fn().mockRejectedValue(new Error('provider unavailable'));

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

async function useTempFiles(): Promise<{ logPath: string; statePath: string }> {
  tempDir = await mkdtemp(join(tmpdir(), 'agent-presence-update-test-'));
  const logPath = join(tempDir, 'agent-presence.log');
  process.env.AGENT_PRESENCE_LOG_FILE = logPath;
  return {
    logPath,
    statePath: join(tempDir, 'state.json')
  };
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
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
