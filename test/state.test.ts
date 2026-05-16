import { describe, expect, it } from 'vitest';
import { applyAgentEvent, createEmptyState, expireStaleSessions, finishAllSessions, getActiveSessions } from '../src/state.js';

describe('agent state lifecycle', () => {
  it('maps codex start, heartbeat, and finish events into local state', () => {
    const state = createEmptyState();

    applyAgentEvent(state, {
      source: 'codex',
      event: 'SessionStart',
      sessionId: 'thread-1',
      now: 1778576582452
    });
    applyAgentEvent(state, {
      source: 'codex',
      event: 'PreToolUse',
      sessionId: 'thread-1',
      now: 1778576891386
    });

    expect(state.sessions['thread-1']).toMatchObject({
      id: 'thread-1',
      source: 'codex',
      kind: 'coding',
      status: 'running',
      startedAt: 1778576582452,
      lastHeartbeatAt: 1778576891386
    });
    expect(getActiveSessions(state, 1778576891386, 180_000)).toHaveLength(1);

    applyAgentEvent(state, {
      source: 'codex',
      event: 'Stop',
      sessionId: 'thread-1',
      now: 1778577015486
    });

    expect(state.sessions['thread-1']?.status).toBe('finished');
    expect(getActiveSessions(state, 1778577015486, 180_000)).toHaveLength(0);
  });

  it('expires running sessions after ttl without a heartbeat', () => {
    const state = createEmptyState();

    applyAgentEvent(state, {
      source: 'codex',
      event: 'SessionStart',
      sessionId: 'thread-1',
      now: 1_000
    });
    expireStaleSessions(state, 181_001, 180_000);

    expect(state.sessions['thread-1']?.status).toBe('expired');
    expect(getActiveSessions(state, 181_001, 180_000)).toHaveLength(0);
  });

  it('finishes all running sessions when resetting presence', () => {
    const state = createEmptyState();

    applyAgentEvent(state, {
      source: 'codex',
      event: 'SessionStart',
      sessionId: 'thread-1',
      now: 1_000
    });
    applyAgentEvent(state, {
      source: 'claude',
      event: 'SessionStart',
      sessionId: 'thread-2',
      now: 2_000
    });

    finishAllSessions(state, 3_000);

    expect(getActiveSessions(state, 3_000, 180_000)).toHaveLength(0);
    expect(state.sessions['thread-1']).toMatchObject({ status: 'finished', finishedAt: 3_000 });
    expect(state.sessions['thread-2']).toMatchObject({ status: 'finished', finishedAt: 3_000 });
  });

  it('finishes the latest matching running session when a stop event has an unstable session id', () => {
    const state = createEmptyState();

    applyAgentEvent(state, {
      source: 'codex',
      event: 'SessionStart',
      sessionId: 'stable-thread-1',
      now: 1_000,
      project: '/repo'
    });
    applyAgentEvent(state, {
      source: 'codex',
      event: 'SessionStart',
      sessionId: 'stable-thread-2',
      now: 2_000,
      project: '/repo'
    });

    applyAgentEvent(state, {
      source: 'codex',
      event: 'Stop',
      sessionId: 'stop-only-id',
      now: 3_000,
      project: '/repo'
    });

    expect(state.sessions['stable-thread-1']?.status).toBe('running');
    expect(state.sessions['stable-thread-2']).toMatchObject({ status: 'finished', finishedAt: 3_000 });
    expect(state.sessions['stop-only-id']).toBeUndefined();
    expect(getActiveSessions(state, 3_000, 180_000).map((session) => session.id)).toEqual(['stable-thread-1']);
  });

  it('does not resurrect a finished session when an older async heartbeat lands late', () => {
    const state = createEmptyState();

    applyAgentEvent(state, {
      source: 'opencode',
      event: 'SessionStart',
      sessionId: 'opencode-session-1',
      now: 1_000
    });
    applyAgentEvent(state, {
      source: 'opencode',
      event: 'Stop',
      sessionId: 'opencode-session-1',
      now: 2_000
    });
    applyAgentEvent(state, {
      source: 'opencode',
      event: 'Heartbeat',
      sessionId: 'opencode-session-1',
      now: 3_000
    });

    expect(state.sessions['opencode-session-1']).toMatchObject({
      status: 'finished',
      finishedAt: 2_000,
      lastHeartbeatAt: 2_000
    });
  });

  it('reopens a finished session when a new user prompt arrives in the same agent session', () => {
    const state = createEmptyState();

    applyAgentEvent(state, {
      source: 'claude',
      event: 'SessionStart',
      sessionId: 'claude-session-1',
      now: 1_000,
      project: '/repo'
    });
    applyAgentEvent(state, {
      source: 'claude',
      event: 'Stop',
      sessionId: 'claude-session-1',
      now: 2_000
    });
    applyAgentEvent(state, {
      source: 'claude',
      event: 'UserPromptSubmit',
      sessionId: 'claude-session-1',
      now: 5_000
    });

    expect(state.sessions['claude-session-1']).toMatchObject({
      status: 'running',
      startedAt: 5_000,
      lastHeartbeatAt: 5_000,
      finishedAt: undefined,
      project: '/repo'
    });
    expect(getActiveSessions(state, 5_000, 180_000).map((session) => session.id)).toEqual(['claude-session-1']);
  });
});
