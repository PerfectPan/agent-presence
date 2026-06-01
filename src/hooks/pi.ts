import { pickString, type StringEnv } from './context.js';

export interface PiHookContext {
  event?: string;
  sessionId?: string;
  project?: string;
}

export function resolvePiHookContext(payload: unknown, env: StringEnv = process.env): PiHookContext {
  const event = pickString(payload, {
    env,
    envKeys: ['PI_HOOK_EVENT', 'PI_EVENT'],
    payloadKeys: ['event', 'hook_event_name', 'type'],
    nestedPayloadKeys: ['session', 'context'],
    payloadFirst: true
  });
  const sessionId = pickString(payload, {
    env,
    envKeys: ['PI_SESSION_ID', 'PI_CODING_AGENT_SESSION_ID'],
    payloadKeys: ['session_id', 'sessionId', 'sessionID'],
    nestedPayloadKeys: ['event', 'session', 'context'],
    payloadFirst: true
  });

  return {
    event,
    sessionId,
    project: pickString(payload, {
      env,
      envKeys: ['PI_PROJECT', 'PI_CWD', 'PWD'],
      payloadKeys: ['cwd', 'project', 'directory'],
      nestedPayloadKeys: ['event', 'session', 'context'],
      payloadFirst: true
    })
  };
}
