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
  it('preserves the per-window badge cache across a load/normalize round trip', () => {
    const raw: PresenceState = {
      ...createEmptyState(),
      usageBadges: { '1': '2.1M · $4.50', '7': '13M · $30.00' },
      usageBadgesAt: 1700
    };
    const normalized = normalizeState(raw);
    expect(normalized.usageBadges).toEqual({ '1': '2.1M · $4.50', '7': '13M · $30.00' });
    expect(normalized.usageBadgesAt).toBe(1700);
  });

  it('preserves valid source snapshots and drops malformed contributions', () => {
    const raw = {
      ...createEmptyState(),
      usageSnapshots: {
        '1': {
          codex: { totalTokens: 100, costUsd: 1.25, scannedAt: 1700 },
          broken: { totalTokens: -1, costUsd: 1, scannedAt: 1700 }
        },
        bad: {
          claude: { totalTokens: 200, costUsd: 2, scannedAt: 1700 }
        }
      }
    } as PresenceState;

    expect(normalizeState(raw).usageSnapshots).toEqual({
      '1': {
        codex: { totalTokens: 100, costUsd: 1.25, scannedAt: 1700 }
      }
    });
  });

  it('drops malformed cache entries and fields', () => {
    const raw = {
      ...createEmptyState(),
      usageBadges: { '1': '2.1M', bad: '5M', '7': 123 },
      usageBadgesAt: 'soon'
    } as unknown as PresenceState;
    const normalized = normalizeState(raw);
    expect(normalized.usageBadges).toEqual({ '1': '2.1M' });
    expect(normalized.usageBadgesAt).toBeUndefined();
  });
});
