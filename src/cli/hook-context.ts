import { resolveGeminiHookContext } from '../hooks/gemini.js';
import { resolveClaudeHookContext } from '../hooks/claude.js';
import { resolveCodexHookContext } from '../hooks/codex.js';
import { resolveOpenCodeHookContext } from '../hooks/opencode.js';
import { resolvePiHookContext } from '../hooks/pi.js';

export interface HookContext {
  event?: string;
  sessionId?: string;
  project?: string;
}

export function resolveHookContext(source: string, payload: unknown): HookContext {
  if (source === 'codex') {
    return resolveCodexHookContext(payload);
  }
  if (source === 'claude') {
    return resolveClaudeHookContext(payload);
  }
  if (source === 'gemini') {
    return resolveGeminiHookContext(payload);
  }
  if (source === 'opencode') {
    return resolveOpenCodeHookContext(payload);
  }
  if (source === 'pi') {
    return resolvePiHookContext(payload);
  }
  return {};
}

export function writeHookOutput(silent: boolean): void {
  if (!silent) {
    process.stdout.write('{}\n');
  }
}
