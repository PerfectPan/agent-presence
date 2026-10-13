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

// The kit bridge (`hook --agent opencode`) forwards each bus event unwrapped,
// so the kit's opencode dialect reads its type at the root. For that shape the
// session id is only the one the dialect reads: the id the event names, or the
// bridge's currentSessionId when it names none; presence reads no field of its
// own. The old bridge (`hook --source opencode`) wraps every payload as
// `{ event }`, which the dialect's root paths never reach, and passes the
// session it last saw in OPENCODE_SESSION_ID; that id must keep winning over a
// late event that names a previous session. Both fallbacks exist only for the
// old bridge.
function openCodeSessionId(payload: unknown, env: StringEnv): string | undefined {
  const kitEvent = readHookEvent('opencode', payload, env);
  if (kitEvent.nativeEvent !== '') {
    return kitEvent.sessionId;
  }
  return (env.OPENCODE_SESSION_ID || undefined) ?? pickOpenCodeSessionId(payload);
}

export function resolveOpenCodeHookContext(payload: unknown, env: StringEnv = process.env): OpenCodeHookContext {
  const event = pickString(payload, { env, envKeys: ['OPENCODE_HOOK_EVENT'] });
  return {
    event: event ? event : mapOpenCodeEvent(payload),
    sessionId: openCodeSessionId(payload, env),
    project: pickString(payload, {
      env,
      envKeys: ['OPENCODE_PROJECT', 'OPENCODE_CWD'],
      payloadKeys: ['cwd', 'directory', 'worktree', 'path'],
      nestedPayloadKeys: NESTED_PAYLOAD_KEYS
    })
  };
}
