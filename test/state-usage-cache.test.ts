import { describe, expect, it } from 'vitest';
import { createEmptyState, isSessionBoundaryEvent, normalizeState } from '../src/state.js';
import type { PresenceState } from '../src/state.js';

describe('isSessionBoundaryEvent', () => {
  it('treats start and finish events as boundaries', () => {
    expect(isSessionBoundaryEvent('SessionStart')).toBe(true);
    expect(isSessionBoundaryEvent('Stop')).toBe(true);
    expect(isSessionBoundaryEvent('SessionEnd')).toBe(true);
    expect(isSessionBoundaryEvent('session.created')).toBe(true);
    expect(isSessionBoundaryEvent('session.deleted')).toBe(true);
  });

  it('excludes subagent boundaries to avoid per-subagent rescans', () => {
    expect(isSessionBoundaryEvent('SubagentStart')).toBe(false);
    expect(isSessionBoundaryEvent('SubagentStop')).toBe(false);
  });

  it('treats tool/heartbeat events as non-boundaries', () => {
    expect(isSessionBoundaryEvent('PreToolUse')).toBe(false);
    expect(isSessionBoundaryEvent('PostToolUse')).toBe(false);
    expect(isSessionBoundaryEvent('Heartbeat')).toBe(false);
    expect(isSessionBoundaryEvent('UserPromptSubmit')).toBe(false);
  });
});

describe('normalizeState usage badge cache', () => {
  it('preserves the cached usage badge across a load/normalize round trip', () => {
    const raw: PresenceState = { ...createEmptyState(), usageBadge: '2.1M · $4.50', usageBadgeAt: 1700 };
    const normalized = normalizeState(raw);
    expect(normalized.usageBadge).toBe('2.1M · $4.50');
    expect(normalized.usageBadgeAt).toBe(1700);
  });

  it('drops malformed cache fields', () => {
    const raw = { ...createEmptyState(), usageBadge: 123, usageBadgeAt: 'soon' } as unknown as PresenceState;
    const normalized = normalizeState(raw);
    expect(normalized.usageBadge).toBeUndefined();
    expect(normalized.usageBadgeAt).toBeUndefined();
  });
});
