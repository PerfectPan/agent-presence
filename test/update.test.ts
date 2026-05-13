import { describe, expect, it, vi } from 'vitest';
import { createEmptyState, applyAgentEvent } from '../src/state.js';
import { markSlotSyncSuccess, prepareSlotSync, rollbackSlotSyncClaim, syncSlot } from '../src/render.js';

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
});
