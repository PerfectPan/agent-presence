import { builtinHookDialects, readHookEvent, type LifecycleEvent } from '@rivus/agent-kit/harness/events';
import { GROK_EVENTS } from '../hooks/grok.js';

// The signal rule these tables implement, including the kit-phase fallback
// for a name a table does not list and why rows differ from the kit phase:
// docs/architecture.md, "Hook Normalization". A table value is the internal
// event name normalizeEvent, applyAgentEvent, and isSessionBoundaryEvent
// understand; `null` ignores the event.

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
  // The payload reader preserves these names even outside Gemini's registration set.
  UserPromptSubmit: 'UserPromptSubmit',
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  Stop: 'Stop',
  BeforeAgent: 'SessionStart',
  BeforeTool: 'Heartbeat',
  AfterTool: 'Heartbeat',
  AfterAgent: 'Stop'
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

/**
 * A skip with the code and fields the queue's skip record needs (Plan 0003 3.2); the applier builds the line the hook
 * used to log from them. `source` names the presence source when one is known, `agent` the kit agent when none is.
 */
export type SkippedHook =
  | { readonly kind: 'skip'; readonly code: 'no-presence-source'; readonly agent: string; readonly nativeEvent: string }
  | { readonly kind: 'skip'; readonly code: 'ignored-event'; readonly source: string; readonly nativeEvent: string };

export type InterpretedHook = { readonly kind: 'apply'; readonly source: string; readonly event: string } | SkippedHook;

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

// session.status: idle (the kit's finish phase) finishes; every other status
// is a heartbeat, although the kit gives busy a start phase.
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
  const event = readHookEvent(declared, payload, env);
  const source = presenceSource(event.agent);
  const nativeEvent = event.nativeEvent === '' ? 'unknown' : event.nativeEvent;
  if (source === undefined) {
    return { kind: 'skip', code: 'no-presence-source', agent: event.agent, nativeEvent };
  }
  const internal = internalEvent(event.agent, event);
  if (internal === null) {
    return { kind: 'skip', code: 'ignored-event', source, nativeEvent };
  }
  return { kind: 'apply', source, event: internal };
}
