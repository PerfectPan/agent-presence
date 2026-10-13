import { readHookEvent } from '@rivus/agent-kit/harness/events';
import type { StringEnv } from './context.js';

export interface GrokHookContext {
  event?: string;
  sessionId?: string;
  project?: string;
}

// The event name is the one Grok sent: its snake_case wire name, or the
// PascalCase spelling newer builds accept. Only a subagent's own start and
// stop compose `<parentSessionId>:subagent:<subagentId ?? subagentType>`, like
// Claude's resolver; other events that carry subagent fields stay on the
// parent session.
const SUBAGENT_EVENT_NAMES = new Set(['SubagentStart', 'SubagentStop', 'subagent_start', 'subagent_stop']);

/**
 * Reads a Grok hook payload through the kit's Grok dialect, which also applies
 * Grok's `GROK_HOOK_EVENT` and `GROK_SESSION_ID` env fallbacks. The project
 * falls back to the hook process's `PWD` when the payload carries no `cwd`.
 */
export function resolveGrokHookContext(payload: unknown, env: StringEnv = process.env): GrokHookContext {
  const event = readHookEvent('grok', payload, env);
  const subagentKey = event.subagent?.id ?? event.subagent?.type;
  const sessionId =
    SUBAGENT_EVENT_NAMES.has(event.nativeEvent) && event.sessionId !== undefined && subagentKey !== undefined
      ? `${event.sessionId}:subagent:${subagentKey}`
      : event.sessionId;

  return {
    event: event.nativeEvent === '' ? undefined : event.nativeEvent,
    sessionId,
    project: event.cwd ?? (env.PWD || undefined)
  };
}
