import { pickString, type StringEnv } from './context.js';

export interface CodexHookContext {
  sessionId?: string;
  project?: string;
}

export function resolveCodexHookContext(payload: unknown, env: StringEnv = process.env): CodexHookContext {
  return {
    sessionId: pickString(payload, {
      env,
      envKeys: ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CMUX_SURFACE_ID'],
      payloadKeys: ['thread_id', 'threadId', 'session_id', 'sessionId', 'conversation_id'],
      nestedPayloadKeys: ['event', 'session', 'input', 'context'],
      payloadFirst: true
    }),
    project: pickString(payload, {
      env,
      envKeys: ['PWD'],
      payloadKeys: ['cwd', 'project'],
      nestedPayloadKeys: ['event', 'session', 'input', 'context'],
      payloadFirst: true
    })
  };
}
