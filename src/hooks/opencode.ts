import { readHookEvent } from '@rivus/agent-kit/harness/events';
import { pickString, type StringEnv } from './context.js';

export interface OpenCodeHookContext {
  sessionId?: string;
  project?: string;
}

export function resolveOpenCodeHookContext(payload: unknown, env: StringEnv = process.env): OpenCodeHookContext {
  return {
    sessionId: readHookEvent('opencode', payload, env).sessionId,
    project: pickString(payload, {
      env,
      envKeys: ['OPENCODE_PROJECT', 'OPENCODE_CWD'],
      payloadKeys: ['cwd', 'directory', 'worktree', 'path'],
      nestedPayloadKeys: ['event', 'session', 'input', 'context', 'project', 'properties', 'info']
    })
  };
}
