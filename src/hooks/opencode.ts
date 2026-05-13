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

export function resolveOpenCodeHookContext(payload: unknown, env: Record<string, string | undefined> = process.env): OpenCodeHookContext {
  return {
    event: env.OPENCODE_HOOK_EVENT ?? mapOpenCodeEvent(payload),
    sessionId: env.OPENCODE_SESSION_ID ?? findString(payload, ['session_id', 'sessionId', 'sessionID', 'id']),
    project:
      env.OPENCODE_PROJECT ??
      env.OPENCODE_CWD ??
      findString(payload, ['cwd', 'directory', 'worktree']) ??
      findString(payload, ['path'])
  };
}

function openCodeEventType(payload: unknown): string | undefined {
  return findString(payload, ['type']);
}

function findString(value: unknown, keys: string[]): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of keys) {
    const field = value[key];
    if (typeof field === 'string' && field.length > 0) {
      return field;
    }
  }

  for (const nestedKey of ['event', 'session', 'input', 'context', 'project']) {
    const nested = value[nestedKey];
    const found = findString(nested, keys);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
