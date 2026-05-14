import { pickString, type StringEnv } from './context.js';

export interface GeminiHookContext {
  event?: string;
  sessionId?: string;
  project?: string;
}

export function resolveGeminiHookContext(payload: unknown, env: StringEnv = process.env): GeminiHookContext {
  const event = pickString(payload, {
    env,
    envKeys: ['GEMINI_HOOK_EVENT_NAME'],
    payloadKeys: ['hook_event_name'],
    nestedPayloadKeys: ['event', 'session', 'input', 'context'],
    payloadFirst: true
  });
  const sessionId = pickString(payload, {
    env,
    envKeys: ['GEMINI_SESSION_ID'],
    payloadKeys: ['session_id', 'sessionId', 'sessionID'],
    nestedPayloadKeys: ['event', 'session', 'input', 'context'],
    payloadFirst: true
  });

  return {
    event,
    sessionId,
    project: pickString(payload, {
      env,
      envKeys: ['GEMINI_PROJECT_DIR', 'GEMINI_CWD', 'PWD'],
      payloadKeys: ['cwd', 'project', 'project_dir'],
      nestedPayloadKeys: ['event', 'session', 'input', 'context'],
      payloadFirst: true
    })
  };
}
