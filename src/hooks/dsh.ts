import { pickString, type StringEnv } from './context.js';

export interface DshHookContext {
  event?: string;
  sessionId?: string;
  project?: string;
}

/**
 * Resolve presence context from a dsh hook payload.
 *
 * dsh has no managed hook installer of its own; the managed dsh plugin
 * (installed by `agent-presence setup`) reports presence and usage by invoking
 * `agent-presence hook --source dsh` with `{ session_id, cwd, model, usage }`
 * on stdin. The same resolver also accepts the Claude Code-dialect payloads
 * that dsh's own `dsh-hooks-claude-code` bridge fires (`hook_event_name`,
 * `session_id`, `cwd`), so a hand-rolled bridge works too. Those event names
 * already normalize on the presence state machine (SessionStart → start,
 * Stop → finish, UserPromptSubmit/PreToolUse/PostToolUse → heartbeat).
 * Usage is ingested separately from the same payload (see usage-events.ts).
 */
export function resolveDshHookContext(payload: unknown, env: StringEnv = process.env): DshHookContext {
  const event = pickString(payload, {
    env,
    envKeys: ['DSH_HOOK_EVENT'],
    payloadKeys: ['hook_event_name', 'event', 'type'],
    payloadFirst: true
  });
  const sessionId = pickString(payload, {
    env,
    envKeys: ['DSH_SESSION_ID'],
    payloadKeys: ['session_id', 'sessionId'],
    payloadFirst: true
  });

  return {
    event,
    sessionId,
    project: pickString(payload, {
      env,
      envKeys: ['DSH_PROJECT', 'DSH_CWD', 'PWD'],
      payloadKeys: ['cwd', 'project', 'directory'],
      payloadFirst: true
    })
  };
}
