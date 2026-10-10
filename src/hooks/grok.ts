import { findPayloadString, pickString, type StringEnv } from './context.js';

export interface GrokHookContext {
  event?: string;
  sessionId?: string;
  project?: string;
}

// Grok sends snake_case wire names; newer builds accept the PascalCase
// spelling in hookEventName. Subagent events compose the session id like
// Claude's resolver does, reading Grok's subagentId/subagentType fields.
const SUBAGENT_EVENT_NAMES = new Set(['SubagentStart', 'SubagentStop', 'subagent_start', 'subagent_stop']);

const NESTED_PAYLOAD_KEYS = ['event', 'session', 'input', 'context'];

export function resolveGrokHookContext(payload: unknown, env: StringEnv = process.env): GrokHookContext {
  const event = pickString(payload, {
    env,
    envKeys: ['GROK_HOOK_EVENT'],
    payloadKeys: ['hookEventName', 'hook_event_name'],
    nestedPayloadKeys: NESTED_PAYLOAD_KEYS,
    payloadFirst: true
  });
  const parentSessionId = pickString(payload, {
    env,
    envKeys: ['GROK_SESSION_ID'],
    payloadKeys: ['sessionId', 'session_id'],
    nestedPayloadKeys: NESTED_PAYLOAD_KEYS,
    payloadFirst: true
  });
  const subagentId = findPayloadString(payload, ['subagentId'], NESTED_PAYLOAD_KEYS);
  const subagentType = findPayloadString(payload, ['subagentType'], NESTED_PAYLOAD_KEYS);
  const subagentKey = subagentId ?? subagentType;
  const sessionId =
    event !== undefined && SUBAGENT_EVENT_NAMES.has(event) && parentSessionId && subagentKey
      ? `${parentSessionId}:subagent:${subagentKey}`
      : parentSessionId;

  return {
    event,
    sessionId,
    project: pickString(payload, {
      env,
      envKeys: ['PWD'],
      payloadKeys: ['cwd'],
      nestedPayloadKeys: NESTED_PAYLOAD_KEYS,
      payloadFirst: true
    })
  };
}
