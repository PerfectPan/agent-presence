import { describe, expect, it } from 'vitest';
import { resolveClaudeHookContext } from '../src/hooks/claude.js';
import { resolveCodexHookContext } from '../src/hooks/codex.js';
import { mapOpenCodeEvent, resolveOpenCodeHookContext } from '../src/hooks/opencode.js';
import { applyAgentEvent, createEmptyState, getActiveSessions } from '../src/state.js';

describe('Codex hook context', () => {
  it('prefers stable payload session ids over process env ids', () => {
    expect(
      resolveCodexHookContext(
        {
          session: {
            thread_id: 'payload-thread-1',
            cwd: '/repo'
          }
        },
        {
          CODEX_SESSION_ID: 'env-session-1',
          PWD: '/env-repo'
        }
      )
    ).toEqual({
      project: '/repo',
      sessionId: 'payload-thread-1'
    });
  });

  it('accepts Codex desktop conversationId payload ids', () => {
    expect(
      resolveCodexHookContext(
        {
          event: {
            conversationId: '019e2ab2-b8d7-79d2-a78d-2b171b617a11',
            cwd: '/repo'
          }
        },
        {
          PWD: '/env-repo'
        }
      )
    ).toEqual({
      project: '/repo',
      sessionId: '019e2ab2-b8d7-79d2-a78d-2b171b617a11'
    });
  });
});

describe('Claude hook context', () => {
  it('uses Claude Code session_id and cwd for main-session hooks', () => {
    expect(
      resolveClaudeHookContext({
        session_id: 'claude-session-1',
        cwd: '/repo',
        hook_event_name: 'UserPromptSubmit'
      })
    ).toEqual({
      event: 'UserPromptSubmit',
      project: '/repo',
      sessionId: 'claude-session-1'
    });
  });

  it('prefers stable Claude payload session ids over process env ids', () => {
    expect(
      resolveClaudeHookContext(
        {
          session: {
            hook_event_name: 'Stop',
            session_id: 'payload-claude-session',
            cwd: '/repo'
          }
        },
        {
          CLAUDE_HOOK_EVENT_NAME: 'UserPromptSubmit',
          CLAUDE_SESSION_ID: 'env-claude-session',
          PWD: '/env-repo'
        }
      )
    ).toEqual({
      event: 'Stop',
      project: '/repo',
      sessionId: 'payload-claude-session'
    });
  });

  it('tracks Claude subagents as separate sessions under the parent session', () => {
    expect(
      resolveClaudeHookContext({
        session_id: 'claude-session-1',
        agent_id: 'agent-2',
        cwd: '/repo',
        hook_event_name: 'SubagentStart'
      })
    ).toEqual({
      event: 'SubagentStart',
      project: '/repo',
      sessionId: 'claude-session-1:subagent:agent-2'
    });
  });

  it('falls back to Claude transcript file names when session_id is absent', () => {
    expect(
      resolveClaudeHookContext({
        transcript_path:
          '/Users/example/.claude/projects/-Users-example-repo/41ef8ec9-cb80-489b-aa69-d328b662814e.jsonl',
        cwd: '/repo',
        hook_event_name: 'UserPromptSubmit'
      })
    ).toEqual({
      event: 'UserPromptSubmit',
      project: '/repo',
      sessionId: '41ef8ec9-cb80-489b-aa69-d328b662814e'
    });
  });
});

describe('opencode hook context', () => {
  it('maps session lifecycle events to agent lifecycle events', () => {
    expect(mapOpenCodeEvent({ type: 'session.created' })).toBe('SessionStart');
    expect(mapOpenCodeEvent({ type: 'session.updated' })).toBe('Heartbeat');
    expect(mapOpenCodeEvent({ type: 'tool.execute.before' })).toBe('Heartbeat');
    expect(mapOpenCodeEvent({ type: 'session.idle' })).toBe('Stop');
    expect(mapOpenCodeEvent({ type: 'session.status', properties: { status: { type: 'idle' } } })).toBe('Stop');
  });

  it('extracts session id from nested opencode event payloads', () => {
    expect(
      resolveOpenCodeHookContext({
        event: {
          type: 'session.created',
          sessionID: 'opencode-session-1',
          cwd: '/repo'
        }
      })
    ).toEqual({
      event: 'SessionStart',
      project: '/repo',
      sessionId: 'opencode-session-1'
    });
  });

  it('prefers opencode session info over event ids', () => {
    expect(
      resolveOpenCodeHookContext({
        event: {
          id: 'evt_fake',
          type: 'session.created',
          properties: {
            info: {
              id: 'ses_real',
              directory: '/repo'
            }
          }
        }
      })
    ).toEqual({
      event: 'SessionStart',
      project: '/repo',
      sessionId: 'ses_real'
    });
  });

  it('does not extract session ids from tool input event ids', () => {
    expect(
      resolveOpenCodeHookContext({
        event: { id: 'evt_fake', type: 'tool.execute.before' },
        input: { id: 'evt_input_fake' }
      })
    ).toEqual({
      event: 'Heartbeat',
      project: undefined,
      sessionId: undefined
    });
  });

  it('does not treat message info ids as session ids', () => {
    expect(
      resolveOpenCodeHookContext({
        event: {
          type: 'message.updated',
          properties: {
            info: { id: 'msg_fake' }
          }
        }
      })
    ).toEqual({
      event: 'Heartbeat',
      project: undefined,
      sessionId: undefined
    });
  });
});

describe('multi-source lifecycle state', () => {
  it('starts and finishes Claude subagents without affecting the parent session', () => {
    const state = createEmptyState();

    applyAgentEvent(state, {
      source: 'claude',
      event: 'SessionStart',
      sessionId: 'claude-session-1',
      now: 1_000
    });
    applyAgentEvent(state, {
      source: 'claude',
      event: 'SubagentStart',
      sessionId: 'claude-session-1:subagent:agent-2',
      now: 2_000
    });
    expect(getActiveSessions(state, 2_000, 180_000).map((session) => session.id)).toEqual([
      'claude-session-1',
      'claude-session-1:subagent:agent-2'
    ]);

    applyAgentEvent(state, {
      source: 'claude',
      event: 'SubagentStop',
      sessionId: 'claude-session-1:subagent:agent-2',
      now: 3_000
    });
    expect(getActiveSessions(state, 3_000, 180_000).map((session) => session.id)).toEqual(['claude-session-1']);

    applyAgentEvent(state, {
      source: 'claude',
      event: 'SessionEnd',
      sessionId: 'claude-session-1',
      now: 4_000
    });
    expect(getActiveSessions(state, 4_000, 180_000)).toHaveLength(0);
  });
});
