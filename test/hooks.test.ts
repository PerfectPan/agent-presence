import { describe, expect, it } from 'vite-plus/test';
import { resolveClaudeHookContext } from '../src/hooks/claude.js';
import { resolveCodexHookContext } from '../src/hooks/codex.js';
import { resolveGrokHookContext } from '../src/hooks/grok.js';
import { mapOpenCodeEvent, resolveOpenCodeHookContext } from '../src/hooks/opencode.js';
import { resolvePiHookContext } from '../src/hooks/pi.js';
import { resolveDshHookContext } from '../src/hooks/dsh.js';
import { resolveHookContext } from '../src/cli/hook-context.js';
import { applyAgentEvent, createEmptyState, finishAllSessions, getActiveSessions } from '../src/state.js';
import { renderPresence } from '../src/render.js';

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
        transcript_path: '/fake-home/.claude/projects/-work-repo/41ef8ec9-cb80-489b-aa69-d328b662814e.jsonl',
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

describe('Grok hook context', () => {
  it('reads Grok snake_case wire names from the payload', () => {
    expect(
      resolveGrokHookContext({
        hook_event_name: 'user_prompt_submit',
        session_id: 'grok-session-1',
        cwd: '/repo'
      })
    ).toEqual({
      event: 'user_prompt_submit',
      project: '/repo',
      sessionId: 'grok-session-1'
    });
  });

  it('accepts the PascalCase hookEventName spelling and camelCase session id', () => {
    expect(
      resolveGrokHookContext({
        hookEventName: 'stop',
        sessionId: 'grok-session-2',
        cwd: '/repo'
      })
    ).toEqual({
      event: 'stop',
      project: '/repo',
      sessionId: 'grok-session-2'
    });
  });

  it('falls back to env when the payload is empty', () => {
    expect(
      resolveGrokHookContext(
        {},
        {
          GROK_HOOK_EVENT: 'session_start',
          GROK_SESSION_ID: 'env-grok-session',
          PWD: '/env-repo'
        }
      )
    ).toEqual({
      event: 'session_start',
      project: '/env-repo',
      sessionId: 'env-grok-session'
    });
  });

  it('prefers payload values over env values', () => {
    expect(
      resolveGrokHookContext(
        {
          hookEventName: 'stop',
          sessionId: 'payload-grok-session',
          cwd: '/repo'
        },
        {
          GROK_HOOK_EVENT: 'session_start',
          GROK_SESSION_ID: 'env-grok-session',
          PWD: '/env-repo'
        }
      )
    ).toEqual({
      event: 'stop',
      project: '/repo',
      sessionId: 'payload-grok-session'
    });
  });

  it('composes a subagent session id from subagentId', () => {
    expect(
      resolveGrokHookContext({
        hookEventName: 'subagent_start',
        sessionId: 'grok-session-1',
        subagentId: 'sub-1',
        cwd: '/repo'
      })
    ).toEqual({
      event: 'subagent_start',
      project: '/repo',
      sessionId: 'grok-session-1:subagent:sub-1'
    });
  });

  it('composes a subagent session id from subagentType when subagentId is absent', () => {
    expect(
      resolveGrokHookContext({
        hook_event_name: 'subagent_stop',
        session_id: 'grok-session-1',
        subagentType: 'explorer',
        cwd: '/repo'
      })
    ).toEqual({
      event: 'subagent_stop',
      project: '/repo',
      sessionId: 'grok-session-1:subagent:explorer'
    });
  });

  it('does not compose a subagent session id on ordinary events', () => {
    expect(
      resolveGrokHookContext({
        hookEventName: 'stop',
        sessionId: 'grok-session-1',
        subagentId: 'sub-1',
        cwd: '/repo'
      })
    ).toEqual({
      event: 'stop',
      project: '/repo',
      sessionId: 'grok-session-1'
    });
  });

  it('routes through resolveHookContext when source is grok', () => {
    expect(resolveHookContext('grok', { hookEventName: 'stop', sessionId: 'grok-session-3', cwd: '/repo' })).toEqual({
      event: 'stop',
      project: '/repo',
      sessionId: 'grok-session-3'
    });
  });
});

describe('opencode hook context — kit bridge session ids', () => {
  it('reads the session id from message info on the kit bridge bus payload', () => {
    expect(
      resolveOpenCodeHookContext({
        type: 'message.updated',
        directory: '/work/repo',
        properties: {
          info: { id: 'msg_1', sessionID: 'ses_new' }
        }
      })
    ).toEqual({
      event: 'Heartbeat',
      project: '/work/repo',
      sessionId: 'ses_new'
    });
  });

  it('reads the session id from message parts on the kit bridge bus payload', () => {
    expect(
      resolveOpenCodeHookContext({
        type: 'message.part.updated',
        properties: {
          part: { id: 'prt_1', sessionID: 'ses_part' }
        }
      })
    ).toEqual({
      event: 'Heartbeat',
      project: undefined,
      sessionId: 'ses_part'
    });
  });

  it('prefers a bus payload session id over the remembered env id', () => {
    expect(
      resolveOpenCodeHookContext(
        {
          type: 'message.updated',
          properties: {
            info: { sessionID: 'ses_live' }
          }
        },
        { OPENCODE_SESSION_ID: 'ses_remembered' }
      )
    ).toEqual({
      event: 'Heartbeat',
      project: undefined,
      sessionId: 'ses_live'
    });
  });

  it('keeps the old bridge heartbeat on the env session when a late message names a previous one', () => {
    // The old bridge remembers the session it last saw created; a late
    // message.updated from the previous session carries that session's id in
    // properties.info.sessionID while the env already names the new one. The
    // env id must win for the wrapped payload shape.
    expect(
      resolveOpenCodeHookContext(
        {
          event: {
            type: 'message.updated',
            properties: {
              info: { id: 'msg_1', sessionID: 'ses_previous' }
            }
          }
        },
        { OPENCODE_SESSION_ID: 'ses_current' }
      )
    ).toEqual({
      event: 'Heartbeat',
      project: undefined,
      sessionId: 'ses_current'
    });
  });

  it('keeps the old bridge heartbeat on the env session for a late message part event', () => {
    expect(
      resolveOpenCodeHookContext(
        {
          event: {
            type: 'message.part.updated',
            properties: {
              part: { id: 'prt_1', sessionID: 'ses_previous' }
            }
          }
        },
        { OPENCODE_SESSION_ID: 'ses_current' }
      )
    ).toEqual({
      event: 'Heartbeat',
      project: undefined,
      sessionId: 'ses_current'
    });
  });

  it('still falls back to the env id when the payload carries none', () => {
    expect(
      resolveOpenCodeHookContext({ type: 'tool.execute.before' }, { OPENCODE_SESSION_ID: 'ses_remembered' })
    ).toEqual({
      event: 'Heartbeat',
      project: undefined,
      sessionId: 'ses_remembered'
    });
  });

  it('keeps resolving the old bridge wrapped payload with a matching env id', () => {
    expect(
      resolveOpenCodeHookContext(
        {
          event: {
            type: 'message.updated',
            properties: {
              info: { id: 'msg_1', sessionID: 'ses_old' }
            }
          }
        },
        { OPENCODE_SESSION_ID: 'ses_old' }
      )
    ).toEqual({
      event: 'Heartbeat',
      project: undefined,
      sessionId: 'ses_old'
    });
  });
});

describe('Pi hook context', () => {
  it('reads pi session id and project from env when the payload is empty', () => {
    expect(
      resolvePiHookContext(
        {},
        {
          PI_SESSION_ID: 'pi-session-1',
          PI_PROJECT: '/repo',
          PI_HOOK_EVENT: 'SessionStart'
        }
      )
    ).toEqual({
      event: 'SessionStart',
      project: '/repo',
      sessionId: 'pi-session-1'
    });
  });

  it('prefers payload session id and event over env values', () => {
    expect(
      resolvePiHookContext(
        {
          session_id: 'payload-session',
          cwd: '/payload-repo',
          event: 'Heartbeat'
        },
        {
          PI_SESSION_ID: 'env-session',
          PI_PROJECT: '/env-repo',
          PI_HOOK_EVENT: 'SessionStart'
        }
      )
    ).toEqual({
      event: 'Heartbeat',
      project: '/payload-repo',
      sessionId: 'payload-session'
    });
  });

  it('routes through resolveHookContext when source is pi', () => {
    expect(resolveHookContext('pi', { session_id: 'pi-session-2', cwd: '/repo', event: 'Stop' })).toEqual({
      event: 'Stop',
      project: '/repo',
      sessionId: 'pi-session-2'
    });
  });
});

describe('dsh hook context', () => {
  it('reads the claude-code dialect payload from dsh-hooks-claude-code', () => {
    expect(
      resolveDshHookContext({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'dsh-session-1',
        cwd: '/repo'
      })
    ).toEqual({
      event: 'UserPromptSubmit',
      project: '/repo',
      sessionId: 'dsh-session-1'
    });
  });

  it('falls back to env when the payload is empty', () => {
    expect(
      resolveDshHookContext(
        {},
        {
          DSH_SESSION_ID: 'env-session',
          DSH_PROJECT: '/env-repo',
          DSH_HOOK_EVENT: 'SessionStart'
        }
      )
    ).toEqual({
      event: 'SessionStart',
      project: '/env-repo',
      sessionId: 'env-session'
    });
  });

  it('routes through resolveHookContext when source is dsh', () => {
    expect(resolveHookContext('dsh', { session_id: 'dsh-session-2', cwd: '/repo', hook_event_name: 'Stop' })).toEqual({
      event: 'Stop',
      project: '/repo',
      sessionId: 'dsh-session-2'
    });
  });
});

describe('Pi lifecycle state', () => {
  it('runs through start -> heartbeat -> stop and disappears from active set', () => {
    const state = createEmptyState();

    applyAgentEvent(state, {
      source: 'pi',
      event: 'SessionStart',
      sessionId: 'pi-session-1',
      project: '/repo',
      now: 1_000
    });
    applyAgentEvent(state, {
      source: 'pi',
      event: 'Heartbeat',
      sessionId: 'pi-session-1',
      project: '/repo',
      now: 2_000
    });
    expect(getActiveSessions(state, 2_000, 180_000).map((session) => session.id)).toEqual(['pi-session-1']);
    expect(state.sessions['pi-session-1']?.source).toBe('pi');

    applyAgentEvent(state, {
      source: 'pi',
      event: 'Stop',
      sessionId: 'pi-session-1',
      now: 3_000
    });
    expect(getActiveSessions(state, 3_000, 180_000)).toHaveLength(0);
    expect(state.sessions['pi-session-1']?.status).toBe('finished');
  });

  it('shows pi in render grouping next to other sources', () => {
    const state = createEmptyState();

    applyAgentEvent(state, {
      source: 'codex',
      event: 'SessionStart',
      sessionId: 'codex-1',
      now: 1_000
    });
    applyAgentEvent(state, {
      source: 'pi',
      event: 'SessionStart',
      sessionId: 'pi-1',
      now: 2_000
    });

    const value = renderPresence(getActiveSessions(state, 2_000, 180_000));
    expect(value).toBe('2 个 AI 牛马正在搬砖 | codex 1 · pi 1');
  });

  it('clears pi sessions on shutdown/reset (finishAllSessions)', () => {
    const state = createEmptyState();

    applyAgentEvent(state, {
      source: 'pi',
      event: 'SessionStart',
      sessionId: 'pi-1',
      now: 1_000
    });

    finishAllSessions(state, 2_000);

    expect(state.sessions['pi-1']?.status).toBe('finished');
    expect(getActiveSessions(state, 2_000, 180_000)).toHaveLength(0);
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
