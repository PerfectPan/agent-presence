import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  getConfigPath,
  pluginSourcesConfig,
  type AppConfig,
  type SourceMatchField,
  type SourceMatchSpec
} from './config.js';
import { pickString, type StringEnv } from './hooks/context.js';
import {
  BUILTIN_SOURCE_PLUGINS,
  isBuiltinSource,
  type SourceContext,
  type SourcePlugin
} from './cli/hook-context.js';
import { writeLog } from './log.js';

export type { SourcePlugin, SourceContext } from './cli/hook-context.js';

/**
 * Environment variable name fragments that may carry the slot credential or
 * other secrets. A config source handler runs in-process and could read
 * `process.env` directly, but we do not *hand* it these: this stops buggy
 * handlers from echoing a token and removes "we give you the credential" as the
 * baseline. Built-in sources are trusted and receive the raw environment.
 */
const SECRET_ENV_PATTERNS = [/TOKEN/i, /SECRET/i, /CREDENTIAL/i, /SLOT_ID/i, /PASSWORD/i, /API_KEY/i];

export function curatedEnv(env: StringEnv): StringEnv {
  const curated: StringEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_ENV_PATTERNS.some((pattern) => pattern.test(key))) {
      continue;
    }
    curated[key] = value;
  }
  return curated;
}

/**
 * Resolve a source id to its hook context through the unified registry.
 * Built-in sources (registered statically) win over a same-id config source and
 * receive the raw environment. Config sources receive a curated environment.
 * Unknown sources with no configuration return `{}` (the unchanged fallback), so
 * a truly unknown `--source` is silently skipped.
 *
 * Fail-open: any loading or resolution error is logged with non-secret fields
 * only and degrades to `{}` — a source must never break a hook.
 */
export async function resolveHookContextForSource(
  source: string,
  payload: unknown,
  config: AppConfig
): Promise<SourceContext> {
  if (isBuiltinSource(source)) {
    return BUILTIN_SOURCE_PLUGINS[source].resolveHookContext(payload, process.env) ?? {};
  }

  const plugin = await loadConfiguredSource(source, config);
  if (!plugin) {
    return {};
  }

  try {
    return plugin.resolveHookContext(payload, curatedEnv(process.env)) ?? {};
  } catch (error) {
    await writeLog(`source resolve failed source=${source} error=${errorName(error)}`);
    return {};
  }
}

const pluginCache = new Map<string, SourcePlugin | undefined>();

async function loadConfiguredSource(source: string, config: AppConfig): Promise<SourcePlugin | undefined> {
  if (pluginCache.has(source)) {
    return pluginCache.get(source);
  }
  const plugin = await loadConfiguredSourceUncached(source, config);
  pluginCache.set(source, plugin);
  return plugin;
}

async function loadConfiguredSourceUncached(source: string, config: AppConfig): Promise<SourcePlugin | undefined> {
  const entry = pluginSourcesConfig(config)[source];
  if (!entry) {
    return undefined;
  }

  if (entry.handler) {
    return loadHandlerSource(source, entry.handler);
  }
  if (entry.match) {
    return buildMatchSource(source, entry.match);
  }

  await writeLog(`source skipped source=${source} reason=no-handler-or-match`);
  return undefined;
}

async function loadHandlerSource(source: string, handler: string): Promise<SourcePlugin | undefined> {
  // A handler runs in-process with full CLI trust, which includes reading the
  // slot credential. Guard the two things an attacker who cannot touch the
  // Keychain might still control: the config file and the handler file.
  if (!isConfigFileTrusted()) {
    await writeLog(`source refused source=${source} reason=untrusted-config`);
    return undefined;
  }

  const specifier = await resolveHandlerSpecifier(source, handler);
  if (!specifier) {
    return undefined;
  }

  try {
    const module = (await import(specifier)) as { default?: unknown };
    const plugin = module.default;
    if (!isSourcePlugin(plugin)) {
      await writeLog(`source invalid source=${source} reason=bad-default-export`);
      return undefined;
    }
    if (plugin.id !== source) {
      await writeLog(`source id mismatch source=${source} handlerId=${plugin.id}`);
      return undefined;
    }
    await writeLog(`source loaded source=${source} handler=${handler}`);
    return plugin;
  } catch (error) {
    await writeLog(`source load failed source=${source} error=${errorName(error)}`);
    return undefined;
  }
}

/**
 * Convert a `handler` config value into a spec `import()` can consume. Absolute
 * paths are validated (owner, mode, symlink) and converted to `file://` URLs;
 * bare specifiers are passed through to resolve via the runtime's module graph.
 */
async function resolveHandlerSpecifier(source: string, handler: string): Promise<string | undefined> {
  if (!isAbsolute(handler)) {
    // Bare npm specifier: resolves through the agent-presence runtime's
    // node_modules, not the user's cwd. Resolution/typo errors surface as a
    // logged load failure in loadHandlerSource.
    return handler;
  }

  try {
    const info = lstatSync(handler);
    if (info.isSymbolicLink()) {
      await writeLog(`source refused source=${source} reason=symlink-handler`);
      return undefined;
    }
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      await writeLog(`source refused source=${source} reason=handler-not-owned`);
      return undefined;
    }
    if ((info.mode & 0o022) !== 0) {
      await writeLog(`source refused source=${source} reason=handler-world-writable`);
      return undefined;
    }
  } catch (error) {
    await writeLog(`source refused source=${source} reason=handler-stat-failed error=${errorName(error)}`);
    return undefined;
  }

  return pathToFileURL(handler).href;
}

/** Whether `config.json` is safe to honor `handler` entries from. */
function isConfigFileTrusted(configPath = getConfigPath()): boolean {
  try {
    const info = lstatSync(configPath);
    if (info.isSymbolicLink()) {
      return false;
    }
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      return false;
    }
    return (info.mode & 0o022) === 0;
  } catch {
    // No config file means no `handler` entries to honor anyway.
    return false;
  }
}

/** Compile a declarative `match` spec into a no-code source. */
export function buildMatchSource(source: string, match: SourceMatchSpec): SourcePlugin {
  return {
    id: source,
    resolveHookContext(payload: unknown, env: StringEnv = {}): SourceContext {
      return {
        event: matchField(payload, env, match.event),
        sessionId: matchField(payload, env, match.sessionId),
        project: matchField(payload, env, match.project)
      };
    }
  };
}

function matchField(payload: unknown, env: StringEnv, field: SourceMatchField | undefined): string | undefined {
  if (!field) {
    return undefined;
  }
  return pickString(payload, {
    env,
    envKeys: field.envKeys,
    payloadKeys: field.payloadKeys,
    nestedPayloadKeys: field.nestedPayloadKeys,
    payloadFirst: field.payloadFirst
  });
}

function isSourcePlugin(value: unknown): value is SourcePlugin {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SourcePlugin).id === 'string' &&
    typeof (value as SourcePlugin).resolveHookContext === 'function'
  );
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

export interface SourceDescriptor {
  id: string;
  origin: 'builtin' | 'config';
  /** A config source whose id collides with a built-in never resolves. */
  shadowedByBuiltin: boolean;
}

/**
 * Every registered source and where it comes from. Used by `config show` so
 * users can confirm wiring without running a hook.
 */
export function describeSources(config: AppConfig): SourceDescriptor[] {
  const builtins: SourceDescriptor[] = Object.keys(BUILTIN_SOURCE_PLUGINS).map((id) => ({
    id,
    origin: 'builtin',
    shadowedByBuiltin: false
  }));
  const configured: SourceDescriptor[] = Object.keys(pluginSourcesConfig(config)).map((id) => ({
    id,
    origin: 'config',
    shadowedByBuiltin: isBuiltinSource(id)
  }));
  return [...builtins, ...configured];
}

/** Test-only: reset the per-process load cache. */
export function resetSourcePluginCacheForTests(): void {
  pluginCache.clear();
}
