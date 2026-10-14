import type { StringEnv } from '../hooks/context.js';
import { resolveGeminiHookContext } from '../hooks/gemini.js';
import { resolveClaudeHookContext } from '../hooks/claude.js';
import { resolveCodexHookContext } from '../hooks/codex.js';
import { resolveGrokHookContext } from '../hooks/grok.js';
import { resolveOpenCodeHookContext } from '../hooks/opencode.js';
import { resolvePiHookContext } from '../hooks/pi.js';
import { resolveDshHookContext } from '../hooks/dsh.js';
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
   * bound is the agent-side hook timeout. May return undefined: a configured
   * `handler` source is third-party code, and the hook path fails open to `{}`.
   */
  resolveHookContext(payload: unknown, env?: StringEnv): SourceContext | undefined;
  /**
   * OPTIONAL usage capability. Scan this source's local transcripts for token
   * usage in the window. A source that implements it is billable; one that omits
   * it contributes presence only. This is after-the-fact and read-only, and is
   * only invoked from the `usage` command and the signature-badge refresh —
   * never from the hook write path. See `docs/architecture.md`.
   */
  scanUsage?(window: ScanWindow): Promise<UsageRecord[]>;
}

/**
 * Environment variables that locate built-in sources' transcripts. The built-in usage scanners read these variables
 * only through these names, and each built-in lists the ones its scanner reads as its `scanEnv`, so a hook can copy
 * every variable a later scan reads without loading a scanner.
 */
export const SCAN_ENV = {
  claudeConfigDir: 'CLAUDE_CONFIG_DIR',
  geminiCliHome: 'GEMINI_CLI_HOME',
  xdgDataHome: 'XDG_DATA_HOME'
} as const;

/** A source that ships in core: its presence resolver and the `SCAN_ENV` names its usage scanner reads. */
export interface BuiltinSource extends Omit<SourcePlugin, 'scanUsage'> {
  readonly scanEnv: readonly string[];
}

/**
 * The sources that ship in core, registered by id. A registry — not an
 * `if`-chain — so built-ins and config sources resolve through the same shape.
 * Built-ins always take precedence over a same-id config source. The table
 * holds no scanner: the built-in usage scanners are in `src/usage/billable-sources.ts`,
 * which the hook path does not load, and the ones without a scanner (`grok`)
 * contribute presence only.
 */
export const BUILTIN_SOURCE_PLUGINS: Record<string, BuiltinSource> = {
  codex: { id: 'codex', resolveHookContext: resolveCodexHookContext, scanEnv: [] },
  claude: { id: 'claude', resolveHookContext: resolveClaudeHookContext, scanEnv: [SCAN_ENV.claudeConfigDir] },
  gemini: { id: 'gemini', resolveHookContext: resolveGeminiHookContext, scanEnv: [SCAN_ENV.geminiCliHome] },
  opencode: { id: 'opencode', resolveHookContext: resolveOpenCodeHookContext, scanEnv: [SCAN_ENV.xdgDataHome] },
  pi: { id: 'pi', resolveHookContext: resolvePiHookContext, scanEnv: [] },
  grok: { id: 'grok', resolveHookContext: resolveGrokHookContext, scanEnv: [] },
  // dsh has no managed hook installer; presence is opt-in via dsh's own
  // `dsh-hooks-claude-code` bridge (see src/hooks/dsh.ts). Usage scanning is
  // independent and always active.
  dsh: { id: 'dsh', resolveHookContext: resolveDshHookContext, scanEnv: [] }
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
  return (plugin && plugin.resolveHookContext(payload)) ?? {};
}

/**
 * Backward-compatible alias for the built-in dispatch. Existing callers and
 * tests import this name; unified resolution lives in `src/sources.ts`.
 */
export const resolveHookContext = resolveBuiltinHookContext;
