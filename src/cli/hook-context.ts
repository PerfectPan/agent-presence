import type { StringEnv } from '../hooks/context.js';
import { resolveGeminiHookContext } from '../hooks/gemini.js';
import { resolveClaudeHookContext } from '../hooks/claude.js';
import { resolveCodexHookContext } from '../hooks/codex.js';
import { resolveOpenCodeHookContext } from '../hooks/opencode.js';
import { resolvePiHookContext } from '../hooks/pi.js';
import { scanClaude } from '../usage/scan-claude.js';
import { scanCodex } from '../usage/scan-codex.js';
import { scanGemini } from '../usage/scan-gemini.js';
import { scanOpenCode } from '../usage/scan-opencode.js';
import { scanPi } from '../usage/scan-pi.js';
import type { ScanWindow, UsageRecord } from '../usage/types.js';

export interface HookContext {
  event?: string;
  sessionId?: string;
  project?: string;
}

/** Alias so the source registry and its callers share one context shape. */
export type SourceContext = HookContext;

/**
 * The one contract every presence source implements, whether it ships in core
 * or is registered from config. Built-in sources are `SourcePlugin`s registered
 * statically here; config-driven sources (see `src/sources.ts`) implement the
 * same interface but are registered at runtime.
 */
export interface SourcePlugin {
  id: string;
  /**
   * Turn a hook payload (and environment) into presence context. MUST be
   * synchronous and do no I/O: it runs on the hook hot path and the only hard
   * bound is the agent-side hook timeout.
   */
  resolveHookContext(payload: unknown, env?: StringEnv): SourceContext;
  /**
   * OPTIONAL usage capability. Scan this source's local transcripts for token
   * usage in the window. A source that implements it is billable; one that omits
   * it contributes presence only. This is after-the-fact and read-only, and is
   * only invoked from the `usage` command and the signature-badge refresh —
   * never from the hook write path. See `rfcs/source-usage.md`.
   */
  scanUsage?(window: ScanWindow): Promise<UsageRecord[]>;
}

/**
 * The sources that ship in core, registered by id. A registry — not an
 * `if`-chain — so built-ins and config sources resolve through the same shape.
 * Built-ins always take precedence over a same-id config source. Every built-in
 * is billable: it pairs a presence resolver with a `scanUsage` transcript scanner.
 */
export const BUILTIN_SOURCE_PLUGINS: Record<string, SourcePlugin> = {
  codex: { id: 'codex', resolveHookContext: resolveCodexHookContext, scanUsage: scanCodex },
  claude: { id: 'claude', resolveHookContext: resolveClaudeHookContext, scanUsage: scanClaude },
  gemini: { id: 'gemini', resolveHookContext: resolveGeminiHookContext, scanUsage: scanGemini },
  opencode: { id: 'opencode', resolveHookContext: resolveOpenCodeHookContext, scanUsage: scanOpenCode },
  pi: { id: 'pi', resolveHookContext: resolvePiHookContext, scanUsage: scanPi }
};

export const BUILTIN_SOURCE_IDS = Object.keys(BUILTIN_SOURCE_PLUGINS);

export function isBuiltinSource(source: string): boolean {
  return source in BUILTIN_SOURCE_PLUGINS;
}

/**
 * Resolve a built-in source to its hook context. Unknown (non-built-in) sources
 * return an empty context; callers that want config sources go through
 * `resolveHookContextForSource` in `src/sources.ts`.
 */
export function resolveBuiltinHookContext(source: string, payload: unknown): HookContext {
  const plugin = BUILTIN_SOURCE_PLUGINS[source];
  return plugin ? plugin.resolveHookContext(payload) : {};
}

/**
 * Backward-compatible alias for the built-in dispatch. Existing callers and
 * tests import this name; unified resolution lives in `src/sources.ts`.
 */
export const resolveHookContext = resolveBuiltinHookContext;

export function writeHookOutput(silent: boolean): void {
  if (!silent) {
    process.stdout.write('{}\n');
  }
}
