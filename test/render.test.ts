import { describe, expect, it } from 'vitest';
import { renderPresence } from '../src/render.js';
import type { AgentSession } from '../src/state.js';

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
