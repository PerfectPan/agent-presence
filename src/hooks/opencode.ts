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
const NESTED_PAYLOAD_KEYS = ['event', 'session', 'input', 'context', 'project', 'properties', 'info'];

export function mapOpenCodeEvent(payload: unknown): string | undefined {
  const type = openCodeEventType(payload);
  if (!type) {
    return undefined;
  }
  if (type === 'session.created') {
    return 'SessionStart';
  }
  if (type === 'session.status' && openCodeSessionStatusType(payload) === 'idle') {
    return 'Stop';
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
  const sessionId = pickString(undefined, { env, envKeys: ['OPENCODE_SESSION_ID'] }) ?? pickOpenCodeSessionId(payload);
  return {
    event: event ? event : mapOpenCodeEvent(payload),
    sessionId,
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

function openCodeSessionStatusType(payload: unknown): string | undefined {
  return findPayloadString(payload, ['statusType'], NESTED_PAYLOAD_KEYS) ?? readStatusType(payload);
}

function readStatusType(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const properties = isRecord(payload.properties) ? payload.properties : undefined;
  const status = properties && isRecord(properties.status) ? properties.status : undefined;
  if (typeof status?.type === 'string' && status.type.length > 0) {
    return status.type;
  }
  return readStatusType(payload.event) ?? readStatusType(payload.session);
}

function pickOpenCodeSessionId(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  return firstString(
    payload.session_id,
    payload.sessionId,
    payload.sessionID,
    pickNestedId(payload.session),
    pickEventSessionId(payload),
    pickOpenCodeSessionId(payload.event),
    pickOpenCodeSessionId(payload.session)
  );
}

function pickEventSessionId(event: Record<string, unknown>): string | undefined {
  const properties = isRecord(event.properties) ? event.properties : undefined;
  const info = properties && isRecord(properties.info) ? properties.info : undefined;
  const session = properties && isRecord(properties.session) ? properties.session : undefined;
  const isSessionEvent = typeof event.type === 'string' && event.type.startsWith('session.');

  return firstString(
    isSessionEvent ? pickNestedId(info) : undefined,
    properties?.sessionID,
    properties?.sessionId,
    properties?.session_id,
    pickNestedId(session)
  );
}

function pickNestedId(value: unknown): string | undefined {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0 ? value.id : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
