import { readHookEvent } from '@rivus/agent-kit/harness/events';
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

function openCodeEventType(payload: unknown): string | undefined {
  return findPayloadString(payload, ['type'], NESTED_PAYLOAD_KEYS);
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

function openCodeSessionStatusType(payload: unknown): string | undefined {
  return findPayloadString(payload, ['statusType'], NESTED_PAYLOAD_KEYS) ?? readStatusType(payload);
}

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

function pickNestedId(value: unknown): string | undefined {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0 ? value.id : undefined;
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

export function resolveOpenCodeHookContext(payload: unknown, env: StringEnv = process.env): OpenCodeHookContext {
  const event = pickString(payload, { env, envKeys: ['OPENCODE_HOOK_EVENT'] });
  // The kit bridge forwards each bus event unwrapped, with its live session id
  // where the kit's opencode dialect reads it (properties.sessionID, the
  // sessionID of properties.info or properties.part, then properties.info.id),
  // so that id wins. The old bridge wraps every payload as `{ event }`, which
  // those root paths never reach, and passes the session it last saw created
  // in OPENCODE_SESSION_ID; that id must keep winning over a late event that
  // names a previous session.
  const sessionId =
    readHookEvent('opencode', payload, env).sessionId ??
    pickString(undefined, { env, envKeys: ['OPENCODE_SESSION_ID'] }) ??
    pickOpenCodeSessionId(payload);
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
