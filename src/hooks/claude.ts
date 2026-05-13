export interface ClaudeHookContext {
  event?: string;
  sessionId?: string;
  project?: string;
}

export function resolveClaudeHookContext(payload: unknown, env: Record<string, string | undefined> = process.env): ClaudeHookContext {
  const record = isRecord(payload) ? payload : {};
  const event = stringField(record, 'hook_event_name') ?? env.CLAUDE_HOOK_EVENT_NAME;
  const parentSessionId =
    env.CLAUDE_SESSION_ID ??
    stringField(record, 'session_id') ??
    stringField(record, 'sessionId') ??
    stringField(record, 'sessionID');
  const agentId = stringField(record, 'agent_id') ?? stringField(record, 'agentId') ?? stringField(record, 'agentID');
  const sessionId = event?.startsWith('Subagent') && parentSessionId && agentId ? `${parentSessionId}:subagent:${agentId}` : parentSessionId;

  return {
    event,
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
