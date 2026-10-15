import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as z from 'zod/mini';
import { hasNodeErrorCode, readJsonFile, writeJsonAtomic } from '../../src/json-file.js';
import { shellQuote } from '../../src/shell-quote.js';

export interface HookCommand {
  type?: unknown;
  command: string;
  timeout?: unknown;
}

export interface HookGroup {
  matcher?: unknown;
  hooks?: HookCommand[];
}

export interface HookSettings {
  hooks: Record<string, HookGroup[]>;
}

const CLAUDE_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'StopFailure',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop'
];
const LEGACY_CLI_COMMAND = 'agent-signature';
const OPENCODE_PLUGIN_REF = './plugins/agent-presence.js';
const LEGACY_OPENCODE_PLUGIN_REF = './plugins/agent-signature.js';

export const PI_EXTENSION_FILE_NAME = 'agent-presence.ts';
export const PI_EXTENSION_MARKER = '@rivus/agent-presence pi extension';

export interface OpenCodeConfig {
  plugin?: unknown;
  [key: string]: unknown;
}

export function isAgentSignatureCommand(command: string): boolean {
  return (
    command.includes('agent-presence hook') ||
    command.includes('@rivus/agent-presence') ||
    command.includes(`${LEGACY_CLI_COMMAND} hook`) ||
    command.includes(`${LEGACY_CLI_COMMAND}.mjs hook`) ||
    command.includes('dist/src/cli.js hook')
  );
}

export function withoutAgentSignatureHookGroups(groups: HookGroup[]): HookGroup[] {
  return groups.flatMap((group) => {
    const hooks = (group.hooks ?? []).filter((hook) => !isAgentSignatureCommand(hook.command));
    return hooks.length > 0 ? [{ ...group, hooks }] : [];
  });
}

export function withoutAgentSignatureHooks(input: Partial<HookSettings>): HookSettings {
  const settings: HookSettings = {
    ...input,
    hooks: {}
  };

  for (const [event, groups] of Object.entries(input.hooks ?? {})) {
    const nextGroups = withoutAgentSignatureHookGroups(groups);
    if (nextGroups.length > 0) {
      settings.hooks[event] = nextGroups;
    }
  }

  return settings;
}

function normalizeOpenCodePlugins(plugin: unknown): unknown[] {
  const entries = z.safeParse(z.array(z.unknown()), plugin);
  if (entries.success) {
    return [...entries.data];
  }
  const entry = z.safeParse(z.string().check(z.minLength(1)), plugin);
  if (entry.success) {
    return [entry.data];
  }
  return [];
}

export function withOpenCodeAgentSignaturePluginConfig(input: OpenCodeConfig): OpenCodeConfig {
  const plugins = normalizeOpenCodePlugins(input.plugin).filter((plugin) => plugin !== LEGACY_OPENCODE_PLUGIN_REF);
  if (!plugins.includes(OPENCODE_PLUGIN_REF)) {
    plugins.push(OPENCODE_PLUGIN_REF);
  }
  return { ...input, plugin: plugins };
}

export function withoutOpenCodeAgentSignaturePluginConfig(input: OpenCodeConfig): OpenCodeConfig {
  const plugins = normalizeOpenCodePlugins(input.plugin).filter(
    (plugin) => plugin !== OPENCODE_PLUGIN_REF && plugin !== LEGACY_OPENCODE_PLUGIN_REF
  );
  const next = { ...input };
  if (plugins.length > 0) {
    next.plugin = plugins;
  } else {
    delete next.plugin;
  }
  return next;
}

export interface PiSettings {
  extensions?: string[];
  [key: string]: unknown;
}

function normalizePiExtensions(extensions: unknown): string[] {
  const entries = z.safeParse(z.array(z.unknown()), extensions);
  if (!entries.success) {
    return [];
  }
  return entries.data.flatMap((entry) => {
    const parsed = z.safeParse(z.string().check(z.minLength(1)), entry);
    return parsed.success ? [parsed.data] : [];
  });
}

const piSettingsSchema = z.looseObject({ extensions: z.optional(z.unknown()) });

async function readPiSettings(path: string): Promise<PiSettings> {
  const input = z.parse(z.record(z.string(), z.unknown()), await readJsonFile<unknown>(path, {}));
  const settings = z.parse(piSettingsSchema, input);
  return { ...input, ...settings, extensions: normalizePiExtensions(settings.extensions) };
}

export function withPiAgentPresenceExtension(input: PiSettings, extensionPath: string): PiSettings {
  const extensions = normalizePiExtensions(input.extensions).filter((entry) => entry !== extensionPath);
  // Auto-discovery already picks up files in ~/.pi/agent/extensions/, so we
  // do not append a duplicate entry by default. We still scrub any prior
  // explicit entry so reruns stay idempotent.
  const next = { ...input };
  if (extensions.length > 0) {
    next.extensions = extensions;
  } else {
    delete next.extensions;
  }
  return next;
}

export function withoutPiAgentPresenceExtension(input: PiSettings, extensionPath: string): PiSettings {
  const extensions = normalizePiExtensions(input.extensions).filter((entry) => entry !== extensionPath);
  const next = { ...input };
  if (extensions.length > 0) {
    next.extensions = extensions;
  } else {
    delete next.extensions;
  }
  return next;
}

export interface PiExtensionPaths {
  extensionPath: string;
  settingsPath: string;
}

export interface PiInstallResult {
  status: 'installed' | 'refused';
  extensionPath: string;
  settingsPath: string;
  settingsUpdated: boolean;
  settingsError?: string;
}

export interface PiUninstallResult {
  status: 'removed' | 'skipped';
  extensionPath: string;
  settingsPath: string;
  settingsUpdated: boolean;
  settingsError?: string;
}

async function readManagedExtension(
  path: string,
  marker: string = PI_EXTENSION_MARKER
): Promise<{ status: 'missing' | 'managed' | 'unmanaged' }> {
  try {
    const contents = await readFile(path, 'utf8');
    return { status: contents.includes(marker) ? 'managed' : 'unmanaged' };
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) {
      return { status: 'missing' };
    }
    throw error;
  }
}

function describeInstallerError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function uninstallPiExtension(paths: PiExtensionPaths): Promise<PiUninstallResult> {
  const existing = await readManagedExtension(paths.extensionPath);
  let status: PiUninstallResult['status'] = 'skipped';
  if (existing.status === 'managed') {
    await rm(paths.extensionPath, { force: true });
    status = 'removed';
  }

  let settingsUpdated = false;
  let settingsError: string | undefined;
  try {
    const settings = await readPiSettings(paths.settingsPath);
    await writeJsonAtomic(paths.settingsPath, withoutPiAgentPresenceExtension(settings, paths.extensionPath));
    settingsUpdated = true;
  } catch (error) {
    settingsError = describeInstallerError(error);
  }

  return {
    status,
    extensionPath: paths.extensionPath,
    settingsPath: paths.settingsPath,
    settingsUpdated,
    settingsError
  };
}

export type PreviousReleaseCommandMode = 'npx' | 'absolute';

const previousReleaseMode = new AsyncLocalStorage<PreviousReleaseCommandMode>();

function agentPresenceCommandParts(): string[] {
  return previousReleaseMode.getStore() === 'absolute'
    ? ['/usr/bin/node', '/work/checkout/dist/src/cli.js']
    : ['npx', '--yes', '--registry=https://registry.npmjs.org', '@rivus/agent-presence@0.9.0'];
}

function buildAgentPresenceShellCommand(args: string[]): string {
  return [...agentPresenceCommandParts(), ...args].map(shellQuote).join(' ');
}

export function buildOpenCodePluginSource(commandParts = agentPresenceCommandParts()): string {
  return `import { spawn, spawnSync } from "node:child_process"

const CLI_COMMAND = ${JSON.stringify(commandParts)}

const HEARTBEAT_EVENTS = new Set([
  "command.executed",
  "file.edited",
  "message.part.updated",
  "message.updated",
  "permission.asked",
  "permission.replied",
  "session.diff",
  "session.status",
  "session.updated",
  "todo.updated",
  "tool.execute.after",
  "tool.execute.before",
])

const FINISH_EVENTS = new Set(["session.deleted", "session.error", "session.idle"])

function mapEvent(event) {
  const type = event?.type
  const props = eventProperties(event)
  if (type === "session.created") return "SessionStart"
  if (type === "session.status" && props.status?.type === "idle") return "Stop"
  if (FINISH_EVENTS.has(type)) return "Stop"
  if (HEARTBEAT_EVENTS.has(type)) return "Heartbeat"
  return undefined
}

let lastSessionId

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

function eventProperties(value) {
  return (value && typeof value === "object" && value.properties && typeof value.properties === "object") ? value.properties : {}
}

function pickSessionId(value) {
  if (!value || typeof value !== "object") return undefined
  const props = eventProperties(value)
  const isSessionEvent = typeof value.type === "string" && value.type.startsWith("session.")
  return firstString(
    value.session_id,
    value.sessionId,
    value.sessionID,
    value.session?.id,
    isSessionEvent ? props.info?.id : undefined,
    props.sessionID,
    props.sessionId,
    props.session_id,
    props.session?.id,
    value.event ? pickSessionId(value.event) : undefined,
    value.session ? pickSessionId(value.session) : undefined
  )
}

function pickProject(ctx, payload) {
  return (
    ctx.directory ||
    ctx.worktree ||
    ctx.project?.path ||
    payload?.event?.cwd ||
    payload?.cwd ||
    process.cwd()
  )
}

function runAgentPresence(eventName, payload, ctx) {
  const sessionId = pickSessionId(payload) || lastSessionId
  if (!sessionId) return
  lastSessionId = sessionId
  const args = [...CLI_COMMAND.slice(1), "hook", "--source", "opencode", "--event", eventName, "--silent"]
  const env = {
    ...process.env,
    OPENCODE_SESSION_ID: sessionId,
    OPENCODE_PROJECT: pickProject(ctx, payload),
  }
  if (eventName === "Stop") {
    try {
      spawnSync(CLI_COMMAND[0], args, {
        input: JSON.stringify(payload),
        encoding: "utf8",
        env,
        stdio: ["pipe", "ignore", "ignore"],
        timeout: 5000,
      })
    } catch (_) {}
    return
  }
  const child = spawn(CLI_COMMAND[0], args, {
    env,
    stdio: ["pipe", "ignore", "ignore"],
    detached: false,
  })
  child.stdin.end(JSON.stringify(payload))
  child.on("error", () => {})
}

export const AgentSignaturePlugin = async (ctx) => {
  return {
    event: async ({ event }) => {
      const eventName = mapEvent(event)
      if (eventName) runAgentPresence(eventName, { event }, ctx)
    },
    "tool.execute.before": async (input) => {
      runAgentPresence("Heartbeat", { event: { type: "tool.execute.before" }, input }, ctx)
    },
    "tool.execute.after": async (input) => {
      runAgentPresence("Heartbeat", { event: { type: "tool.execute.after" }, input }, ctx)
    },
  }
}

export default AgentSignaturePlugin
`;
}

export function buildPiExtensionSource(commandParts = agentPresenceCommandParts()): string {
  return `// ${PI_EXTENSION_MARKER}
//
// Bridges Pi Coding Agent lifecycle events into @rivus/agent-presence so that
// Pi appears in the presence renderer alongside Codex / Claude Code / Gemini
// CLI / opencode. Active state is driven by Pi's own lifecycle events; we
// never scan processes or terminal windows.
//
// Generated by \`agent-presence setup\`. Do not edit by hand. Re-running
// setup will overwrite this file; \`agent-presence uninstall\` removes it.
import { spawn, spawnSync } from "node:child_process"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"

const CLI_COMMAND = ${JSON.stringify(commandParts)}

function emit(event: string, sync: boolean, ctx: ExtensionContext): void {
  let sessionId: string | undefined
  let cwd: string | undefined
  try {
    sessionId = ctx.sessionManager?.getSessionId?.()
    cwd = ctx.cwd
  } catch (_) {
    return
  }
  if (!sessionId) return

  const args = [...CLI_COMMAND.slice(1), "hook", "--source", "pi", "--event", event, "--silent"]
  const env = {
    ...process.env,
    PI_SESSION_ID: sessionId,
    PI_PROJECT: cwd ?? process.cwd(),
    PI_HOOK_EVENT: event,
  }
  const payload = JSON.stringify({
    event,
    session_id: sessionId,
    cwd: env.PI_PROJECT,
  })

  if (sync) {
    try {
      spawnSync(CLI_COMMAND[0], args, {
        input: payload,
        encoding: "utf8",
        env,
        stdio: ["pipe", "ignore", "ignore"],
        timeout: 5000,
      })
    } catch (_) {
      // Never let presence telemetry break Pi.
    }
    return
  }

  try {
    const child = spawn(CLI_COMMAND[0], args, {
      env,
      stdio: ["pipe", "ignore", "ignore"],
      detached: false,
    })
    child.stdin.end(payload)
    child.on("error", () => {})
  } catch (_) {
    // Never let presence telemetry break Pi.
  }
}

export default function (pi: ExtensionAPI) {
  // session_start with reason "startup" alone is just "Pi is open"; do not
  // count that as active. Wait until before_agent_start, when the user has
  // actually submitted a task.
  pi.on("before_agent_start", async (_event, ctx) => {
    emit("SessionStart", false, ctx)
  })

  pi.on("turn_start", async (_event, ctx) => {
    emit("Heartbeat", false, ctx)
  })

  pi.on("tool_execution_start", async (_event, ctx) => {
    emit("Heartbeat", false, ctx)
  })

  pi.on("tool_execution_end", async (_event, ctx) => {
    emit("Heartbeat", false, ctx)
  })

  pi.on("agent_end", async (_event, ctx) => {
    emit("Stop", true, ctx)
  })

  pi.on("session_shutdown", async (_event, ctx) => {
    emit("Stop", true, ctx)
  })
}
`;
}

export async function installPiExtension(paths: PiExtensionPaths): Promise<PiInstallResult> {
  await mkdir(dirname(paths.extensionPath), { recursive: true, mode: 0o700 });
  const existing = await readManagedExtension(paths.extensionPath);
  if (existing.status === 'unmanaged') {
    throw new Error(
      `refusing to overwrite ${paths.extensionPath}: it is not managed by @rivus/agent-presence. ` +
        'Delete or rename that file, then rerun setup.'
    );
  }
  await writeFile(paths.extensionPath, buildPiExtensionSource(), { mode: 0o600 });

  let settingsUpdated = false;
  let settingsError: string | undefined;
  try {
    const settings = await readPiSettings(paths.settingsPath);
    await writeJsonAtomic(paths.settingsPath, withPiAgentPresenceExtension(settings, paths.extensionPath));
    settingsUpdated = true;
  } catch (error) {
    settingsError = describeInstallerError(error);
  }

  return {
    status: 'installed',
    extensionPath: paths.extensionPath,
    settingsPath: paths.settingsPath,
    settingsUpdated,
    settingsError
  };
}

export function withClaudeAgentSignatureHooks(input: Partial<HookSettings>): HookSettings {
  const settings: HookSettings = {
    ...input,
    hooks: { ...input.hooks }
  };

  for (const event of CLAUDE_EVENTS) {
    const groups = settings.hooks[event] ?? [];
    settings.hooks[event] = withoutAgentSignatureHookGroups(groups);
    settings.hooks[event].push({
      hooks: [
        {
          type: 'command',
          command: `${buildAgentPresenceShellCommand(['hook', '--source', 'claude', '--event', event, '--silent'])} >/dev/null 2>/dev/null || true`,
          timeout: 5000
        }
      ]
    });
  }

  return settings;
}

const GEMINI_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'];

export function withGeminiAgentSignatureHooks(input: Partial<HookSettings>): HookSettings {
  const settings: HookSettings = {
    ...input,
    hooks: { ...input.hooks }
  };

  for (const event of GEMINI_EVENTS) {
    const groups = settings.hooks[event] ?? [];
    settings.hooks[event] = withoutAgentSignatureHookGroups(groups);
    settings.hooks[event].push({
      hooks: [
        {
          type: 'command',
          command: `${buildAgentPresenceShellCommand(['hook', '--source', 'gemini', '--event', event, '--silent'])} >/dev/null 2>/dev/null || true`,
          timeout: 5000
        }
      ]
    });
  }

  return settings;
}

export const PREVIOUS_RELEASE_ARTIFACT_PATHS = {
  claudeSettings: '.claude/settings.json',
  codexHooks: '.codex/hooks.json',
  geminiSettings: '.gemini/settings.json',
  opencodeConfig: '.config/opencode/opencode.json',
  opencodePlugin: '.config/opencode/plugins/agent-presence.js',
  piSettings: '.pi/agent/settings.json',
  piExtension: '.pi/agent/extensions/agent-presence.ts'
} as const;

export function previousReleasePaths(homeDir: string) {
  return {
    claudeSettings: join(homeDir, PREVIOUS_RELEASE_ARTIFACT_PATHS.claudeSettings),
    codexHooks: join(homeDir, PREVIOUS_RELEASE_ARTIFACT_PATHS.codexHooks),
    geminiSettings: join(homeDir, PREVIOUS_RELEASE_ARTIFACT_PATHS.geminiSettings),
    opencodeConfig: join(homeDir, PREVIOUS_RELEASE_ARTIFACT_PATHS.opencodeConfig),
    opencodePlugin: join(homeDir, PREVIOUS_RELEASE_ARTIFACT_PATHS.opencodePlugin),
    piSettings: join(homeDir, PREVIOUS_RELEASE_ARTIFACT_PATHS.piSettings),
    piExtension: join(homeDir, PREVIOUS_RELEASE_ARTIFACT_PATHS.piExtension)
  };
}

const hookSettingsSchema = z.looseObject({
  hooks: z.optional(
    z.record(
      z.string(),
      z.array(
        z.looseObject({
          hooks: z.optional(
            z.array(
              z.looseObject({
                command: z.string()
              })
            )
          )
        })
      )
    )
  )
});

const preservingHookSettingsSchema = z.custom<Partial<HookSettings>>(
  (input) => z.safeParse(hookSettingsSchema, input).success
);

async function readHookSettings(path: string): Promise<Partial<HookSettings>> {
  return z.parse(preservingHookSettingsSchema, await readJsonFile<unknown>(path, { hooks: {} }));
}

async function readOpenCodeConfig(path: string): Promise<OpenCodeConfig> {
  return z.parse(z.record(z.string(), z.unknown()), await readJsonFile<unknown>(path, {}));
}

async function installCodexHooks(hooksPath: string): Promise<void> {
  const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'];

  interface HooksFile {
    hooks?: Record<string, HookGroup[]>;
  }

  function withoutAgentSignatureHooks(groups: HookGroup[]): HookGroup[] {
    const next: HookGroup[] = [];
    for (const group of groups) {
      const hooks = (group.hooks ?? []).filter((hook) => !isAgentSignatureCommand(hook.command));
      if (hooks.length > 0) {
        next.push({ ...group, hooks });
      }
    }
    return next;
  }

  async function loadHooks(path: string): Promise<HooksFile> {
    return readHookSettings(path);
  }

  const doc = await loadHooks(hooksPath);
  doc.hooks ??= {};

  for (const event of EVENTS) {
    const groups = doc.hooks[event] ?? [];
    doc.hooks[event] = withoutAgentSignatureHooks(groups);
    doc.hooks[event].push({
      hooks: [
        {
          type: 'command',
          command: `${buildAgentPresenceShellCommand(['hook', '--source', 'codex', '--event', event])} 2>/dev/null || echo '{}'`,
          timeout: 5000
        }
      ]
    });
  }

  await writeJsonAtomic(hooksPath, doc);
}

export async function installPreviousRelease(options: {
  homeDir: string;
  commandMode: PreviousReleaseCommandMode;
}): Promise<void> {
  await previousReleaseMode.run(options.commandMode, async () => {
    const paths = previousReleasePaths(options.homeDir);
    await writeJsonAtomic(
      paths.claudeSettings,
      withClaudeAgentSignatureHooks(await readHookSettings(paths.claudeSettings))
    );
    await installCodexHooks(paths.codexHooks);
    await writeJsonAtomic(
      paths.geminiSettings,
      withGeminiAgentSignatureHooks(await readHookSettings(paths.geminiSettings))
    );
    await mkdir(dirname(paths.opencodePlugin), { recursive: true, mode: 0o700 });
    await writeFile(paths.opencodePlugin, buildOpenCodePluginSource(), { mode: 0o600 });
    await writeJsonAtomic(
      paths.opencodeConfig,
      withOpenCodeAgentSignaturePluginConfig(await readOpenCodeConfig(paths.opencodeConfig))
    );
    await installPiExtension({ extensionPath: paths.piExtension, settingsPath: paths.piSettings });
  });
}

export async function uninstallPreviousRelease(options: { homeDir: string }): Promise<void> {
  const paths = previousReleasePaths(options.homeDir);
  for (const path of [paths.claudeSettings, paths.codexHooks, paths.geminiSettings]) {
    await writeJsonAtomic(path, withoutAgentSignatureHooks(await readHookSettings(path)));
  }
  await rm(paths.opencodePlugin, { force: true });
  await rm(join(dirname(paths.opencodePlugin), 'agent-signature.js'), { force: true });
  await writeJsonAtomic(
    paths.opencodeConfig,
    withoutOpenCodeAgentSignaturePluginConfig(await readOpenCodeConfig(paths.opencodeConfig))
  );
  await uninstallPiExtension({ extensionPath: paths.piExtension, settingsPath: paths.piSettings });
}
