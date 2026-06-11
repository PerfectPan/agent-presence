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

  it('appends the usage badge when a template omits {usage}', () => {
    expect(renderPresence([session('thread-1', 'codex')], {}, '2.1M · $4.50')).toBe(
      '1 个 AI 牛马正在搬砖 | codex 1 | 今日 2.1M · $4.50'
    );
    // also appended on the zero-agent template
    expect(renderPresence([], {}, '2.1M · $4.50')).toBe('AI 牛马暂未开工 | 今日 2.1M · $4.50');
  });

  it('substitutes {usage} in place when the template references it', () => {
    expect(
      renderPresence([session('thread-1', 'codex')], { one: '{details} · 今日 {usage}' }, '900K')
    ).toBe('codex 1 · 今日 900K');
  });

  it('omits the badge entirely when usage is empty', () => {
    expect(renderPresence([session('thread-1', 'codex')], {}, '')).toBe('1 个 AI 牛马正在搬砖 | codex 1');
  });
});

describe('prepareSlotSync usage badge', () => {
  function stateWith(badge?: string): PresenceState {
    return {
      sessions: { s1: session('s1', 'claude') },
      lastSlotUpdateAt: 0,
      lastValue: '',
      usageBadge: badge
    };
  }

  const opts = { force: true, now: 1000, debounceMs: 0, ttlMs: 60_000 };

  it('embeds the cached badge when usageEnabled', () => {
    const decision = prepareSlotSync(stateWith('2.1M · $4.50'), { ...opts, usageEnabled: true });
    expect(decision.action).toBe('update');
    if (decision.action === 'update') {
      expect(decision.value).toBe('1 个 AI 牛马正在搬砖 | claude 1 | 今日 2.1M · $4.50');
    }
  });

  it('ignores the cached badge when usageEnabled is false', () => {
    const decision = prepareSlotSync(stateWith('2.1M · $4.50'), { ...opts, usageEnabled: false });
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
