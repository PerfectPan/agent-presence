import { builtinHookDialects, readHookEvent, type LifecycleEvent } from '@rivus/agent-kit/harness/events';

// Presence keeps the internal event names normalizeEvent, applyAgentEvent, and
// isSessionBoundaryEvent already understand. Each agent's table is Plan 0002
// §3.4: a listed name maps to that row's signal, including where the kit phase
// disagrees. `null` ignores the event. A name the table does not list takes
// SessionStart, Stop, or Heartbeat from the kit phase (start, finish, or
// activity/blocked/unknown).

type KitAgentId = LifecycleEvent['agent'];
type EventTable = Readonly<Record<string, string | null>>;

const CLAUDE_EVENTS: EventTable = {
  SessionStart: 'SessionStart',
  UserPromptSubmit: 'UserPromptSubmit',
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  Stop: 'Stop',
  StopFailure: 'StopFailure',
  SessionEnd: 'SessionEnd',
  SubagentStart: 'SubagentStart',
  SubagentStop: 'SubagentStop'
};

const CODEX_EVENTS: EventTable = {
  SessionStart: 'SessionStart',
  UserPromptSubmit: 'UserPromptSubmit',
  PreToolUse: 'PreToolUse',
  Stop: 'Stop'
};

const GEMINI_EVENTS: EventTable = {
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
  // Old registrations Gemini never dispatched. The old form keeps today's
  // signal; the same names do too when they arrive on --agent.
  UserPromptSubmit: 'UserPromptSubmit',
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  Stop: 'Stop',
  BeforeAgent: 'SessionStart',
  BeforeTool: 'Heartbeat',
  AfterTool: 'Heartbeat',
  AfterAgent: 'Stop'
};

const GROK_EVENTS: EventTable = {
  session_start: 'SessionStart',
  user_prompt_submit: 'UserPromptSubmit',
  pre_tool_use: 'PreToolUse',
  post_tool_use: 'PostToolUse',
  stop: 'Stop',
  stop_failure: 'StopFailure',
  session_end: 'SessionEnd',
  subagent_start: 'SubagentStart',
  subagent_stop: 'SubagentStop',
  // Registration keys. nativeEvent is usually the snake_case wire name; the
  // PascalCase spelling is the same event, and phase fallback would turn
  // UserPromptSubmit into a session start and SubagentStop into a boundary.
  SessionStart: 'SessionStart',
  UserPromptSubmit: 'UserPromptSubmit',
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  Stop: 'Stop',
  StopFailure: 'StopFailure',
  SessionEnd: 'SessionEnd',
  SubagentStart: 'SubagentStart',
  SubagentStop: 'SubagentStop'
};

const OPENCODE_EVENTS: EventTable = {
  'session.created': 'SessionStart',
  'message.updated': 'Heartbeat',
  'message.part.updated': 'Heartbeat',
  'tool.execute.before': 'Heartbeat',
  'tool.execute.after': 'Heartbeat',
  'command.executed': 'Heartbeat',
  'file.edited': 'Heartbeat',
  'todo.updated': 'Heartbeat',
  'session.diff': 'Heartbeat',
  'session.updated': 'Heartbeat',
  'session.compacted': 'Heartbeat',
  'permission.asked': 'Heartbeat',
  'permission.updated': 'Heartbeat',
  'permission.replied': 'Heartbeat',
  'question.asked': 'Heartbeat',
  'question.replied': 'Heartbeat',
  'question.rejected': 'Heartbeat',
  'session.idle': 'Stop',
  'session.error': 'Stop',
  'session.deleted': 'Stop'
};

const PI_EVENTS: EventTable = {
  // Opening the Pi UI is not active work. The kit phase is start; the old
  // extension never forwarded this event.
  session_start: null,
  before_agent_start: 'SessionStart',
  agent_start: 'SessionStart',
  turn_start: 'Heartbeat',
  turn_end: 'Heartbeat',
  tool_call: 'Heartbeat',
  tool_execution_start: 'Heartbeat',
  tool_execution_end: 'Heartbeat',
  session_compact: 'Heartbeat',
  ui_prompt_start: 'Heartbeat',
  ui_prompt_end: 'Heartbeat',
  agent_end: 'Stop',
  agent_settled: 'Stop',
  session_shutdown: 'Stop'
};

const EVENT_TABLES: Readonly<Record<string, EventTable>> = {
  'claude-code': CLAUDE_EVENTS,
  codex: CODEX_EVENTS,
  'gemini-cli': GEMINI_EVENTS,
  grok: GROK_EVENTS,
  opencode: OPENCODE_EVENTS,
  pi: PI_EVENTS
};

export type InterpretedHook =
  | { readonly kind: 'apply'; readonly source: string; readonly event: string }
  | { readonly kind: 'skip'; readonly reason: string };

function declaredAgent(id: string): KitAgentId | undefined {
  for (const dialect of Object.values(builtinHookDialects)) {
    if (dialect.agent === id) {
      return dialect.agent;
    }
  }
  return undefined;
}

function presenceSource(agent: KitAgentId): string | undefined {
  switch (agent) {
    case 'claude-code':
      return 'claude';
    case 'gemini-cli':
      return 'gemini';
    case 'codex':
    case 'grok':
    case 'opencode':
    case 'pi':
      return agent;
    default:
      return undefined;
  }
}

function tableValue(table: EventTable, nativeEvent: string): string | null | undefined {
  for (const [name, value] of Object.entries(table)) {
    if (name === nativeEvent) {
      return value;
    }
  }
  return undefined;
}

function eventFromPhase(phase: LifecycleEvent['phase']): string {
  if (phase === 'start') {
    return 'SessionStart';
  }
  if (phase === 'finish') {
    return 'Stop';
  }
  return 'Heartbeat';
}

// session.status's busy case is a kit start phase. Presence keeps every
// non-idle status a heartbeat, matching the old bridge: only idle finishes,
// and a busy blip must not take the start signal.
function openCodeStatusEvent(event: LifecycleEvent): string {
  return event.phase === 'finish' ? 'Stop' : 'Heartbeat';
}

function internalEvent(agent: KitAgentId, event: LifecycleEvent): string | null {
  if (agent === 'opencode' && event.nativeEvent === 'session.status') {
    return openCodeStatusEvent(event);
  }
  const table = EVENT_TABLES[agent];
  if (table !== undefined) {
    const mapped = tableValue(table, event.nativeEvent);
    if (mapped !== undefined) {
      return mapped;
    }
  }
  return eventFromPhase(event.phase);
}

function hookEnvironment(env: NodeJS.ProcessEnv): Readonly<Record<string, string | undefined>> {
  const copy: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    copy[key] = env[key];
  }
  return copy;
}

/**
 * Interpret one `hook --agent` payload. The presence source is the sniffed
 * `LifecycleEvent.agent`, not the declared flag: Grok and Cursor also run
 * Claude Code's hooks. Cursor has no presence source, so the event is skipped.
 */
export function interpretAgentHook(agentId: string, payload: unknown, env: NodeJS.ProcessEnv): InterpretedHook {
  const declared = declaredAgent(agentId);
  if (declared === undefined) {
    throw new Error(`Agent "${agentId}" has no hook dialect`);
  }
  const event = readHookEvent(declared, payload, hookEnvironment(env));
  const source = presenceSource(event.agent);
  const nativeEvent = event.nativeEvent === '' ? 'unknown' : event.nativeEvent;
  if (source === undefined) {
    return { kind: 'skip', reason: `no presence source for agent=${event.agent} event=${nativeEvent}` };
  }
  const internal = internalEvent(event.agent, event);
  if (internal === null) {
    return { kind: 'skip', reason: `ignored event source=${source} event=${nativeEvent}` };
  }
  return { kind: 'apply', source, event: internal };
}
