import { lstatSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  getConfigPath,
  getPluginsDir,
  pluginSourcesConfig,
  type AppConfig,
  type SourceMatchField,
  type SourceMatchSpec,
  type SourcePluginConfig
} from './config.js';
import { pickString, type StringEnv } from './hooks/context.js';
import {
  BUILTIN_SOURCE_PLUGINS,
  type SourceContext,
  type SourcePlugin
} from './cli/hook-context.js';
import { writeLog } from './log.js';

export type { SourcePlugin, SourceContext } from './cli/hook-context.js';

/** A `handler` of the form `builtin:<id>` reuses a shipped in-code resolver. */
const BUILTIN_HANDLER_PREFIX = 'builtin:';

/**
 * Environment variable name fragments that may carry the slot credential or
 * other secrets. This is a **best-effort denylist**, not a guarantee: a handler
 * runs in-process and can read `process.env` (or the OS keyring) directly, so
 * this cannot enforce confidentiality. Its purpose is narrow — cover this app's
 * own credential vars and common secret-name shapes so we do not *hand* a token
 * to a handler by default and a buggy handler cannot trivially echo one. It
 * intentionally errs toward stripping (any `*TOKEN*`/`*SECRET*`/… name). Built-in
 * (`builtin:`) sources are trusted and receive the raw env.
 */
const SECRET_ENV_PATTERNS = [/TOKEN/i, /SECRET/i, /CREDENTIAL/i, /SLOT_ID/i, /PASSWORD/i, /API_?KEY/i, /PRIVATE_?KEY/i, /ACCESS_KEY/i];

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

interface DefaultSourcesFile {
  sources?: Record<string, SourcePluginConfig>;
}

let defaultSourcesCache: Record<string, SourcePluginConfig> | undefined;

/** The shipped default source table (the five built-ins as `builtin:<id>`). */
function defaultSources(): Record<string, SourcePluginConfig> {
  if (defaultSourcesCache) {
    return defaultSourcesCache;
  }
  try {
    const path = fileURLToPath(new URL('./sources.default.json', import.meta.url));
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as DefaultSourcesFile;
    defaultSourcesCache = parsed.sources ?? {};
  } catch {
    // If the shipped defaults are somehow missing, fall back to the in-code
    // built-in ids so presence never silently stops counting first-party agents.
    defaultSourcesCache = Object.fromEntries(
      Object.keys(BUILTIN_SOURCE_PLUGINS).map((id) => [id, { handler: `${BUILTIN_HANDLER_PREFIX}${id}` }])
    );
  }
  return defaultSourcesCache;
}

/**
 * The effective source table: the shipped defaults with the user's
 * `config.plugins.sources` merged over them by id. A same-id user entry
 * overrides the default (retarget or disable a built-in); a new id adds a
 * source. Entries with `enabled: false` are dropped.
 */
export function mergedSources(config: AppConfig): Record<string, SourcePluginConfig> {
  const merged: Record<string, SourcePluginConfig> = { ...defaultSources() };
  for (const [id, entry] of Object.entries(pluginSourcesConfig(config))) {
    merged[id] = entry;
  }
  for (const [id, entry] of Object.entries(merged)) {
    if (entry.enabled === false) {
      delete merged[id];
    }
  }
  return merged;
}

/**
 * Resolve a source id to its hook context through the merged source table.
 * A `builtin:` entry reuses a trusted shipped resolver (raw environment); a user
 * `handler`/`match` entry is guarded and receives a credential-stripped
 * environment. A disabled or unknown source returns `{}` (the unchanged
 * fallback), so those `--source` hooks are silently skipped.
 *
 * Fail-open: any loading or resolution error is logged with non-secret fields
 * only and degrades to `{}` — a source must never break a hook.
 */
export async function resolveHookContextForSource(
  source: string,
  payload: unknown,
  config: AppConfig
): Promise<SourceContext> {
  const entry = mergedSources(config)[source];
  if (!entry) {
    return {};
  }

  const builtinId = builtinHandlerId(entry.handler);
  if (builtinId) {
    const plugin = BUILTIN_SOURCE_PLUGINS[builtinId];
    if (!plugin) {
      await writeLog(`source invalid source=${source} reason=unknown-builtin builtin=${builtinId}`);
      return {};
    }
    // Trusted: shipped resolver, raw environment (built-ins use env fallbacks).
    return plugin.resolveHookContext(payload, process.env) ?? {};
  }

  const plugin = await loadConfiguredSource(source, entry);
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

function builtinHandlerId(handler: string | undefined): string | undefined {
  if (handler && handler.startsWith(BUILTIN_HANDLER_PREFIX)) {
    return handler.slice(BUILTIN_HANDLER_PREFIX.length);
  }
  return undefined;
}

const pluginCache = new Map<string, SourcePlugin | undefined>();

async function loadConfiguredSource(source: string, entry: SourcePluginConfig): Promise<SourcePlugin | undefined> {
  if (pluginCache.has(source)) {
    return pluginCache.get(source);
  }
  const plugin = await loadConfiguredSourceUncached(source, entry);
  pluginCache.set(source, plugin);
  return plugin;
}

async function loadConfiguredSourceUncached(source: string, entry: SourcePluginConfig): Promise<SourcePlugin | undefined> {
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
 * bare specifiers are resolved against the plugins dir's `node_modules` (where
 * `source add` installs packages).
 */
async function resolveHandlerSpecifier(source: string, handler: string): Promise<string | undefined> {
  if (!isAbsolute(handler)) {
    // Bare npm specifier: resolve strictly from the plugins dir's node_modules
    // (where `source add` installs), not the user's cwd and not ancestor
    // node_modules. The explicit `paths` confines resolution to that directory.
    try {
      const require = createRequire(join(getPluginsDir(), 'noop.js'));
      return pathToFileURL(require.resolve(handler, { paths: [join(getPluginsDir(), 'node_modules')] })).href;
    } catch (error) {
      await writeLog(`source refused source=${source} reason=specifier-unresolved error=${errorName(error)}`);
      return undefined;
    }
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
    // A writable parent dir lets another user swap the (otherwise fine) file, so
    // narrow the swap window by requiring the directory be owned and not
    // group/world-writable too. This does not fully close the check-to-import
    // TOCTOU gap (see the RFC), but removes the easy directory-swap vector.
    const parent = lstatSync(dirname(handler));
    if (typeof process.getuid === 'function' && parent.uid !== process.getuid()) {
      await writeLog(`source refused source=${source} reason=handler-dir-not-owned`);
      return undefined;
    }
    if ((parent.mode & 0o022) !== 0) {
      await writeLog(`source refused source=${source} reason=handler-dir-world-writable`);
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

export type SourceValidation = { ok: true; id: string } | { ok: false; reason: string };

/**
 * Import a just-installed package by name and confirm its default export is a
 * usable `SourcePlugin`, returning its declared `id`. Used by `source add` to
 * fail loudly before writing a config entry, rather than discovering a bad
 * package silently at hook time.
 */
export async function loadSourcePluginForValidation(packageName: string): Promise<SourceValidation> {
  const specifier = await resolveHandlerSpecifier(packageName, packageName);
  if (!specifier) {
    return { ok: false, reason: 'package could not be resolved from the plugins dir' };
  }
  try {
    const module = (await import(specifier)) as { default?: unknown };
    if (!isSourcePlugin(module.default)) {
      return { ok: false, reason: 'default export is not a { id, resolveHookContext } source plugin' };
    }
    return { ok: true, id: module.default.id };
  } catch (error) {
    return { ok: false, reason: errorName(error) };
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

export type SourceKind = 'builtin' | 'handler' | 'match' | 'invalid';

export interface SourceDescriptor {
  id: string;
  /** Whether this id comes from the shipped defaults or the user's config. */
  origin: 'default' | 'config';
  /** How the source resolves: a trusted built-in, a JS handler, or a match spec. */
  kind: SourceKind;
  /** Whether a user config entry has overridden the shipped default for this id. */
  overridesDefault: boolean;
}

/**
 * The merged source table described for `config show`, so users can confirm
 * which sources are active, where each comes from, and how it resolves —
 * without running a hook. Disabled sources are omitted (they are not active).
 */
export function describeSources(config: AppConfig): SourceDescriptor[] {
  const defaults = defaultSources();
  const userEntries = pluginSourcesConfig(config);
  return Object.entries(mergedSources(config)).map(([id, entry]) => {
    const fromConfig = id in userEntries;
    return {
      id,
      origin: fromConfig ? 'config' : 'default',
      kind: sourceKind(entry),
      overridesDefault: fromConfig && id in defaults
    };
  });
}

function sourceKind(entry: SourcePluginConfig): SourceKind {
  if (builtinHandlerId(entry.handler)) {
    return 'builtin';
  }
  if (entry.handler) {
    return 'handler';
  }
  if (entry.match) {
    return 'match';
  }
  return 'invalid';
}

/** Test-only: reset the per-process caches. */
export function resetSourcePluginCacheForTests(): void {
  pluginCache.clear();
  defaultSourcesCache = undefined;
}
