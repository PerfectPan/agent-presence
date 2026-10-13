import { readHookEvent } from '@rivus/agent-kit/harness/events';
import type { StringEnv } from './context.js';

export interface GrokHookContext {
  event?: string;
  sessionId?: string;
  project?: string;
}

/**
 * Grok's hook event names mapped to presence's internal event names, for
 * `hook --source grok` without `--event` and for `hook --agent grok`. Grok
 * sends the snake_case wire names; a PascalCase registration key is the same
 * event and must map the same way, because `--agent` takes an unlisted name's
 * signal from the kit phase, which would make UserPromptSubmit a session start
 * and SubagentStop a boundary.
 */
export const GROK_EVENTS: Readonly<Record<string, string>> = {
  session_start: 'SessionStart',
  user_prompt_submit: 'UserPromptSubmit',
  pre_tool_use: 'PreToolUse',
  post_tool_use: 'PostToolUse',
  stop: 'Stop',
  stop_failure: 'StopFailure',
  session_end: 'SessionEnd',
  subagent_start: 'SubagentStart',
  subagent_stop: 'SubagentStop',
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

/**
 * Reads a Grok hook payload through the kit's Grok dialect, which also applies
 * Grok's `GROK_HOOK_EVENT` and `GROK_SESSION_ID` env fallbacks. A name outside
 * `GROK_EVENTS` is returned as Grok sent it. The project falls back to the hook
 * process's `PWD` when the payload carries no `cwd`.
 */
export function resolveGrokHookContext(payload: unknown, env: StringEnv = process.env): GrokHookContext {
  const event = readHookEvent('grok', payload, env);
  const name = Object.hasOwn(GROK_EVENTS, event.nativeEvent) ? GROK_EVENTS[event.nativeEvent] : undefined;
  // Only a subagent's own start and stop compose
  // `<parentSessionId>:subagent:<subagentId ?? subagentType>`, like Claude's
  // resolver; other events that carry subagent fields stay on the parent.
  const subagentKey = event.subagent?.id ?? event.subagent?.type;
  const isSubagentEvent = name === 'SubagentStart' || name === 'SubagentStop';
  const sessionId =
    isSubagentEvent && event.sessionId !== undefined && subagentKey !== undefined
      ? `${event.sessionId}:subagent:${subagentKey}`
      : event.sessionId;

  return {
    event: name ?? (event.nativeEvent === '' ? undefined : event.nativeEvent),
    sessionId,
    project: event.cwd ?? (env.PWD || undefined)
  };
}
