import { findPayloadString, pickString, type StringEnv } from './context.js';

export interface OpenCodeHookContext {
  event?: string;
  sessionId?: string;
  project?: string;
}

const HEARTBEAT_EVENTS = new Set([
  'command.executed',
  'file.edited',
  'message.part.updated',
  'message.updated',
  'permission.asked',
  'permission.replied',
  'session.diff',
  'session.status',
  'session.updated',
  'todo.updated',
  'tool.execute.after',
  'tool.execute.before'
]);

const FINISH_EVENTS = new Set(['session.deleted', 'session.error', 'session.idle']);
const NESTED_PAYLOAD_KEYS = ['event', 'session', 'input', 'context', 'project'];

export function mapOpenCodeEvent(payload: unknown): string | undefined {
  const type = openCodeEventType(payload);
  if (!type) {
    return undefined;
  }
  if (type === 'session.created') {
    return 'SessionStart';
  }
  if (FINISH_EVENTS.has(type)) {
    return 'Stop';
  }
  if (HEARTBEAT_EVENTS.has(type)) {
    return 'Heartbeat';
  }
  return undefined;
}

export function resolveOpenCodeHookContext(payload: unknown, env: StringEnv = process.env): OpenCodeHookContext {
  const event = pickString(payload, { env, envKeys: ['OPENCODE_HOOK_EVENT'] });
  return {
    event: event ? event : mapOpenCodeEvent(payload),
    sessionId: pickString(payload, {
      env,
      envKeys: ['OPENCODE_SESSION_ID'],
      payloadKeys: ['session_id', 'sessionId', 'sessionID', 'id'],
      nestedPayloadKeys: NESTED_PAYLOAD_KEYS
    }),
    project: pickString(payload, {
      env,
      envKeys: ['OPENCODE_PROJECT', 'OPENCODE_CWD'],
      payloadKeys: ['cwd', 'directory', 'worktree', 'path'],
      nestedPayloadKeys: NESTED_PAYLOAD_KEYS
    })
  };
}

function openCodeEventType(payload: unknown): string | undefined {
  return findPayloadString(payload, ['type'], NESTED_PAYLOAD_KEYS);
}
