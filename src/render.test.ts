import { describe, expect, it, vi } from 'vite-plus/test';
import {
  markSlotSyncSuccess,
  prepareSlotSync,
  renderFallbackTitleWithoutUsageTokens,
  renderPresence,
  rollbackSlotSyncClaim,
  syncSlot,
  usageResetDeadlineMs
} from './render.js';
import { applyAgentEvent, createEmptyState, type AgentSession, type PresenceState } from './state.js';
import { badgeExpiryMs, startOfLocalDayMs } from './time.js';

function session(id: string, source: string): AgentSession {
  return {
    id,
    source,
    kind: 'coding',
    status: 'running',
    startedAt: 1778576582452,
    lastHeartbeatAt: 1778576891386
  };
}

describe('renderPresence', () => {
  it('renders no active agents', () => {
    expect(renderPresence([])).toBe('AI 牛马暂未开工');
  });

  it('renders one codex agent', () => {
    expect(renderPresence([session('thread-1', 'codex')])).toBe('1 个 AI 牛马正在搬砖 | codex 1');
  });

  it('renders multiple agents grouped by source in first-seen order', () => {
    expect(
      renderPresence([session('thread-1', 'codex'), session('thread-2', 'claude'), session('thread-3', 'codex')])
    ).toBe('3 个 AI 牛马正在搬砖 | codex 2 · claude 1');
  });

  it('caps signature text at 200 characters', () => {
    const active = Array.from({ length: 40 }, (_, index) => session(`thread-${index}`, `agent-${index}`));

    expect(renderPresence(active)).toHaveLength(200);
  });

  it('keeps default copy when optional template keys are undefined', () => {
    expect(renderPresence([], { zero: undefined })).toBe('AI 牛马暂未开工');
    expect(renderPresence([session('thread-1', 'codex')], { one: undefined })).toBe('1 个 AI 牛马正在搬砖 | codex 1');
  });

  it('auto-appends the default-window badge when a template omits {usage} tokens', () => {
    expect(renderPresence([session('thread-1', 'codex')], {}, {}, ' | 今日 2.1M · $4.50')).toBe(
      '1 个 AI 牛马正在搬砖 | codex 1 | 今日 2.1M · $4.50'
    );
    // also appended on the zero-agent template
    expect(renderPresence([], {}, {}, ' | 今日 2.1M · $4.50')).toBe('AI 牛马暂未开工 | 今日 2.1M · $4.50');
  });

  it('substitutes {usage} / {usage_1d} / {usage_7d} tokens, never auto-appending when a token is present', () => {
    expect(
      renderPresence(
        [session('thread-1', 'codex')],
        { one: '{details} · 今日 {usage_1d} · 近7天 {usage_7d}' },
        { usage_1d: '900K', usage_7d: '5M' },
        ' | 今日 900K'
      )
    ).toBe('codex 1 · 今日 900K · 近7天 5M');
  });

  it('collapses a referenced-but-unavailable window to empty', () => {
    expect(renderPresence([session('thread-1', 'codex')], { one: '{details}{usage_30d}' }, { usage_1d: '900K' })).toBe(
      'codex 1'
    );
  });

  it('omits the badge entirely when no vars and no auto-append', () => {
    expect(renderPresence([session('thread-1', 'codex')], {}, {}, '')).toBe('1 个 AI 牛马正在搬砖 | codex 1');
  });
});

describe('prepareSlotSync usage badges', () => {
  function stateWith(badges?: Record<string, string>): PresenceState {
    return {
      sessions: { s1: session('s1', 'claude') },
      lastSlotUpdateAt: 0,
      lastValue: '',
      usageBadges: badges
    };
  }

  const opts = { force: true, now: 1000, debounceMs: 0, ttlMs: 60_000 };

  it('auto-appends the default window when enabled and the template has no token', () => {
    const decision = prepareSlotSync(stateWith({ '1': '2.1M · $4.50' }), {
      ...opts,
      usage: { enabled: true, defaultWindow: 1 }
    });
    expect(decision.action).toBe('update');
    if (decision.action === 'update') {
      expect(decision.value).toBe('1 个 AI 牛马正在搬砖 | claude 1 | 今日 2.1M · $4.50');
    }
  });

  it('labels a 7-day default window as 近7天', () => {
    const decision = prepareSlotSync(stateWith({ '7': '5M · $30.00' }), {
      ...opts,
      usage: { enabled: true, defaultWindow: 7 }
    });
    if (decision.action === 'update') {
      expect(decision.value).toBe('1 个 AI 牛马正在搬砖 | claude 1 | 近7天 5M · $30.00');
    }
  });

  it('exposes {usage_1d}/{usage_7d} from the cache for consumer-composed templates', () => {
    const decision = prepareSlotSync(stateWith({ '1': '900K', '7': '5M' }), {
      ...opts,
      renderTemplates: { one: '{details} | 今 {usage_1d} 周 {usage_7d}' },
      usage: { enabled: true, defaultWindow: 1 }
    });
    if (decision.action === 'update') {
      expect(decision.value).toBe('claude 1 | 今 900K 周 5M');
    }
  });

  // Local-time constructors so staleness (which snaps to local midnight) is
  // timezone-robust: both the cache time and `now` are built the same way.
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h, 0, 0).getTime();

  function stateWithCache(badges: Record<string, string>, computedAt: number): PresenceState {
    return {
      sessions: { s1: session('s1', 'claude') },
      lastSlotUpdateAt: 0,
      lastValue: '',
      usageBadges: badges,
      usageBadgesAt: computedAt
    };
  }

  it('shows the cached badge while it is still the same calendar day', () => {
    const decision = prepareSlotSync(stateWithCache({ '1': '2.1M · $4.50' }, at(2024, 0, 1, 9)), {
      ...opts,
      now: at(2024, 0, 1, 23), // same day, 14h later
      renderTemplates: { one: '{details} | 今日 {usage_1d}' },
      usage: { enabled: true, defaultWindow: 1 }
    });
    if (decision.action === 'update') {
      expect(decision.value).toBe('claude 1 | 今日 2.1M · $4.50');
    }
  });

  it('replaces the 今日 badge with a placeholder once a midnight has passed', () => {
    const decision = prepareSlotSync(stateWithCache({ '1': '2.1M · $4.50' }, at(2024, 0, 1, 23)), {
      ...opts,
      now: at(2024, 0, 2, 9), // next calendar day
      renderTemplates: { one: '{details} | 今日 {usage_1d}' },
      usage: { enabled: true, defaultWindow: 1 }
    });
    if (decision.action === 'update') {
      expect(decision.value).toBe('claude 1 | 今日 —');
    }
  });

  it('staleness is per-window: 今日 expires after one midnight while 近7天 survives', () => {
    const decision = prepareSlotSync(stateWithCache({ '1': '2.1M', '7': '13M' }, at(2024, 0, 1, 23)), {
      ...opts,
      now: at(2024, 0, 2, 9), // one midnight crossed: stale for 1d, fresh for 7d
      renderTemplates: { one: '{details} | 今日 {usage_1d} · 近7天 {usage_7d}' },
      usage: { enabled: true, defaultWindow: 1 }
    });
    if (decision.action === 'update') {
      expect(decision.value).toBe('claude 1 | 今日 — · 近7天 13M');
    }
  });

  it('expires the 7-day badge once seven days have elapsed', () => {
    const decision = prepareSlotSync(stateWithCache({ '7': '13M' }, at(2024, 0, 1, 12)), {
      ...opts,
      now: at(2024, 0, 8, 12), // seven midnights crossed
      renderTemplates: { one: '{details} | 近7天 {usage_7d}' },
      usage: { enabled: true, defaultWindow: 7 }
    });
    if (decision.action === 'update') {
      expect(decision.value).toBe('claude 1 | 近7天 —');
    }
  });

  it('drops the auto-append entirely when the default window is stale', () => {
    const decision = prepareSlotSync(stateWithCache({ '1': '2.1M · $4.50' }, at(2024, 0, 1, 23)), {
      ...opts,
      now: at(2024, 0, 2, 9),
      usage: { enabled: true, defaultWindow: 1 }
    });
    if (decision.action === 'update') {
      expect(decision.value).toBe('1 个 AI 牛马正在搬砖 | claude 1');
    }
  });

  it('treats a cache with no recorded timestamp as fresh (back-compat)', () => {
    const decision = prepareSlotSync(stateWith({ '1': '2.1M · $4.50' }), {
      ...opts,
      now: at(2024, 5, 1),
      usage: { enabled: true, defaultWindow: 1 }
    });
    if (decision.action === 'update') {
      expect(decision.value).toBe('1 个 AI 牛马正在搬砖 | claude 1 | 今日 2.1M · $4.50');
    }
  });

  it('ignores cached badges when usage is disabled', () => {
    const decision = prepareSlotSync(stateWith({ '1': '2.1M · $4.50' }), {
      ...opts,
      usage: { enabled: false, defaultWindow: 1 }
    });
    if (decision.action === 'update') {
      expect(decision.value).toBe('1 个 AI 牛马正在搬砖 | claude 1');
    }
  });

  it('renders configurable copy with total and detail variables', () => {
    expect(
      renderPresence([session('thread-1', 'codex'), session('thread-2', 'opencode')], {
        one: '单线程摸鱼 | {details}',
        many: '{total} 个 AI 牛马并行搬砖 | {details}',
        zero: 'AI 牛马下班了'
      })
    ).toBe('2 个 AI 牛马并行搬砖 | codex 1 · opencode 1');

    expect(
      renderPresence([], {
        zero: 'AI 牛马下班了',
        one: '{total} 个 AI 牛马正在搬砖 | {details}',
        many: '{total} 个 AI 牛马并行搬砖 | {details}'
      })
    ).toBe('AI 牛马下班了');
  });
});

describe('the published usage deadline', () => {
  function stateWith(badges?: Record<string, string>): PresenceState {
    return {
      sessions: { s1: session('s1', 'claude') },
      lastSlotUpdateAt: 0,
      lastValue: '',
      usageBadges: badges
    };
  }

  // A badge computed at 23:50 local on 2026-11-07 turns stale at the next midnight.
  const lateEvening = new Date(2026, 10, 7, 23, 50).getTime();

  it('expires a window at the midnight that completes its span', () => {
    expect(badgeExpiryMs(lateEvening, 1)).toBe(startOfLocalDayMs(lateEvening) + 24 * 60 * 60 * 1000);
    expect(badgeExpiryMs(lateEvening, 7)).toBe(startOfLocalDayMs(lateEvening) + 7 * 24 * 60 * 60 * 1000);
    // At the deadline itself the badge reads the wrong day, exactly like the staleness check.
    expect(usageResetDeadlineMs(lateEvening, [1])).toBe(startOfLocalDayMs(lateEvening) + 24 * 60 * 60 * 1000);
  });

  it('is the earliest referenced midnight, and none without a badge or a compute time', () => {
    expect(usageResetDeadlineMs(lateEvening, [1, 7])).toBe(usageResetDeadlineMs(lateEvening, [1]));
    expect(usageResetDeadlineMs(undefined, [1])).toBeUndefined();
    expect(usageResetDeadlineMs(lateEvening, [])).toBeUndefined();
  });

  it('rides on the slot sync decision and is published with the value', () => {
    const state = { ...stateWith({ '1': '2.1M · $4.50' }), usageBadgesAt: lateEvening };
    const decision = prepareSlotSync(state, {
      force: true,
      now: lateEvening,
      debounceMs: 0,
      ttlMs: 60_000,
      usage: { enabled: true, defaultWindow: 1 }
    });
    if (decision.action !== 'update') {
      throw new Error('no update');
    }
    expect(decision.usageResetDeadlineMs).toBe(startOfLocalDayMs(lateEvening) + 24 * 60 * 60 * 1000);
    markSlotSyncSuccess(state, decision);
    expect(state.usageResetDeadlineMs).toBe(startOfLocalDayMs(lateEvening) + 24 * 60 * 60 * 1000);
  });

  it('is absent when usage is off or the cache predates the deadline fields', () => {
    const decision = prepareSlotSync(stateWith(), {
      force: true,
      now: lateEvening,
      debounceMs: 0,
      ttlMs: 60_000,
      usage: { enabled: true, defaultWindow: 1 }
    });
    expect(decision.action === 'update' && decision.usageResetDeadlineMs).toBeUndefined();
    const legacy = prepareSlotSync(
      { ...stateWith({ '1': '2.1M' }), usageBadgesAt: undefined },
      {
        force: true,
        now: lateEvening,
        debounceMs: 0,
        ttlMs: 60_000,
        usage: { enabled: true, defaultWindow: 1 }
      }
    );
    expect(legacy.action === 'update' && legacy.usageResetDeadlineMs).toBeUndefined();
  });
});

describe('the fallback title', () => {
  it('drops the usage tokens and the segments that held only them', () => {
    expect(renderFallbackTitleWithoutUsageTokens('AI 牛马暂未开工 | {usage}')).toBe('AI 牛马暂未开工');
    expect(renderFallbackTitleWithoutUsageTokens('{usage} 个会话')).toBe('个会话');
    expect(renderFallbackTitleWithoutUsageTokens('a | {usage_7d} | b')).toBe('a | b');
    expect(renderFallbackTitleWithoutUsageTokens('no tokens here')).toBe('no tokens here');
  });
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
    const updateSlot = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined);

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
    const updateSlot = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined);

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
