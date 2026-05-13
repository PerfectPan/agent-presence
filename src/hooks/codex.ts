export interface CodexHookContext {
  sessionId?: string;
  project?: string;
}

export function codexLifecycleEvent(event: string): 'start' | 'heartbeat' | 'finish' {
  if (event === 'SessionStart') {
    return 'start';
  }
  if (event === 'Stop') {
    return 'finish';
  }
  return 'heartbeat';
}

export function resolveCodexHookContext(payload: unknown, env: NodeJS.ProcessEnv = process.env): CodexHookContext {
  const record = isRecord(payload) ? payload : {};
  const sessionId =
    env.CODEX_THREAD_ID ??
    env.CODEX_SESSION_ID ??
    env.CMUX_SURFACE_ID ??
    stringField(record, 'thread_id') ??
    stringField(record, 'threadId') ??
    stringField(record, 'session_id') ??
    stringField(record, 'sessionId') ??
    stringField(record, 'conversation_id');

  return {
    sessionId,
    project: stringField(record, 'cwd') ?? env.PWD
  };
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
