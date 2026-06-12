import { describe, expect, it } from 'vitest';
import { prepareSlotSync, renderPresence } from '../src/render.js';
import type { AgentSession, PresenceState } from '../src/state.js';

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
      renderPresence([
        session('thread-1', 'codex'),
        session('thread-2', 'claude'),
        session('thread-3', 'codex')
      ])
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
    expect(
      renderPresence([session('thread-1', 'codex')], { one: '{details}{usage_30d}' }, { usage_1d: '900K' })
    ).toBe('codex 1');
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
