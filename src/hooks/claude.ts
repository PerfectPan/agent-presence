import { pickString, type StringEnv } from './context.js';

export interface ClaudeHookContext {
  event?: string;
  sessionId?: string;
  project?: string;
}

export function resolveClaudeHookContext(payload: unknown, env: StringEnv = process.env): ClaudeHookContext {
  const event = pickString(payload, {
    env,
    envKeys: ['CLAUDE_HOOK_EVENT_NAME'],
    payloadKeys: ['hook_event_name']
  });
  const parentSessionId = pickString(payload, {
    env,
    envKeys: ['CLAUDE_SESSION_ID'],
    payloadKeys: ['session_id', 'sessionId', 'sessionID']
  });
  const agentId = pickString(payload, {
    payloadKeys: ['agent_id', 'agentId', 'agentID']
  });
  const sessionId = event?.startsWith('Subagent') && parentSessionId && agentId ? `${parentSessionId}:subagent:${agentId}` : parentSessionId;

  return {
    event,
    sessionId,
    project: pickString(payload, {
      env,
      envKeys: ['PWD'],
      payloadKeys: ['cwd'],
      payloadFirst: true
    })
  };
}
