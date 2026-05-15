import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}

export interface HookGroup {
  matcher?: string;
  hooks?: HookCommand[];
}

export interface HookSettings {
  hooks: Record<string, HookGroup[]>;
}

export interface CodexHookTrustEntry {
  key: string;
  trustedHash: string;
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

export interface OpenCodeConfig {
  plugin?: string | string[];
  [key: string]: unknown;
}

export interface ShutdownWatcherPlistOptions {
  label: string;
  scriptPath: string;
  logPath?: string;
  errorLogPath?: string;
}

export interface ShutdownWatcherScriptOptions {
  pathEntries?: string[];
  powerEventWatcherPath?: string;
}

export function withClaudeAgentSignatureHooks(input: Partial<HookSettings>): HookSettings {
  const settings: HookSettings = {
    ...input,
    hooks: { ...(input.hooks ?? {}) }
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

export function withoutAgentSignatureHookGroups(groups: HookGroup[]): HookGroup[] {
  return groups.flatMap((group) => {
    const hooks = (group.hooks ?? []).filter((hook) => !isAgentSignatureCommand(hook.command));
    return hooks.length > 0 ? [{ ...group, hooks }] : [];
  });
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

export function withTrustedCodexHookHashes(configText: string, entries: CodexHookTrustEntry[]): string {
  if (entries.length === 0) {
    return configText;
  }

  const entryByKey = new Map(entries.map((entry) => [entry.key, entry.trustedHash]));
  const seen = new Set<string>();
  const lines = configText.split(/\r?\n/);
  const output: string[] = [];
  let currentKey: string | undefined;

  for (const line of lines) {
    const sectionKey = parseCodexHookStateSection(line);
    if (sectionKey !== undefined) {
      const hash = entryByKey.get(sectionKey);
      if (currentKey !== undefined && entryByKey.has(currentKey) && !seen.has(currentKey)) {
        output.push(`trusted_hash = "${entryByKey.get(currentKey)}"`);
        seen.add(currentKey);
      }
      currentKey = hash === undefined ? undefined : sectionKey;
      output.push(line);
      continue;
    }

    if (currentKey !== undefined && line.startsWith('trusted_hash = ')) {
      output.push(`trusted_hash = "${entryByKey.get(currentKey)}"`);
      seen.add(currentKey);
      continue;
    }

    output.push(line);
  }

  if (currentKey !== undefined && entryByKey.has(currentKey) && !seen.has(currentKey)) {
    output.push(`trusted_hash = "${entryByKey.get(currentKey)}"`);
    seen.add(currentKey);
  }

  const missing = entries.filter((entry) => !seen.has(entry.key));
  if (missing.length > 0) {
    while (output.length > 0 && output.at(-1) === '') {
      output.pop();
    }
    output.push('');
    for (const entry of missing) {
      output.push(`[hooks.state."${escapeTomlString(entry.key)}"]`);
      output.push(`trusted_hash = "${entry.trustedHash}"`);
      output.push('');
    }
  }

  return `${output.join('\n').replace(/\n+$/, '')}\n`;
}

function parseCodexHookStateSection(line: string): string | undefined {
  const match = line.match(/^\[hooks\.state\."((?:\\.|[^"\\])+)"\]$/);
  if (!match) {
    return undefined;
  }
  return unescapeTomlString(match[1] ?? '');
}

function escapeTomlString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function unescapeTomlString(value: string): string {
  return value.replace(/\\(["\\])/g, '$1');
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

function normalizeOpenCodePlugins(plugin: string | string[] | undefined): string[] {
  if (Array.isArray(plugin)) {
    return [...plugin];
  }
  if (typeof plugin === 'string' && plugin.length > 0) {
    return [plugin];
  }
  return [];
}

export function buildShutdownWatcherScript(options: ShutdownWatcherScriptOptions = {}): string {
  const pathEntries = (options.pathEntries ?? []).filter((entry) => entry.length > 0);
  const pathExport = pathEntries.length > 0 ? `export PATH="${escapeShellDoubleQuoted(pathEntries.join(':'))}:$PATH"\n\n` : '';
  const powerWatcherLoop = options.powerEventWatcherPath
    ? `while true; do
  if [ -x /usr/bin/swift ] && [ -f "${escapeShellDoubleQuoted(options.powerEventWatcherPath)}" ]; then
    /usr/bin/swift "${escapeShellDoubleQuoted(options.powerEventWatcherPath)}" &
    watcher_pid=$!
    wait "$watcher_pid" || true
    watcher_pid=""
  else
    sleep 3600 &
    watcher_pid=$!
    wait "$watcher_pid" || true
    watcher_pid=""
  fi
  sleep 2
done`
    : `while true; do
  sleep 3600 &
  watcher_pid=$!
  wait "$watcher_pid" || true
  watcher_pid=""
done`;
  return `#!/bin/zsh
set -u

${pathExport}\
watcher_pid=""

cleanup() {
  if [ -n "\${watcher_pid:-}" ]; then
    kill "$watcher_pid" >/dev/null 2>/dev/null || true
  fi
  ${buildAgentPresenceShellCommand(['reset', '--force', '--silent'])} >/dev/null 2>/dev/null || true
}

trap cleanup TERM HUP INT EXIT

${powerWatcherLoop}
`;
}

export function buildPowerEventWatcherSwift(): string {
  return `#!/usr/bin/env swift
import AppKit
import Foundation

func resetPresence(reason: String) {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/bin/zsh")
    task.arguments = ["-lc", "${escapeSwiftString(buildAgentPresenceShellCommand(['reset', '--force', '--silent']))} >/dev/null 2>/dev/null || true"]
    task.environment = ProcessInfo.processInfo.environment
    do {
        try task.run()
        task.waitUntilExit()
    } catch {
        // Never let the watcher crash because reset failed.
    }
}

let center = NSWorkspace.shared.notificationCenter
let notifications: [Notification.Name] = [
    NSWorkspace.willSleepNotification,
    NSWorkspace.screensDidSleepNotification,
    NSWorkspace.didWakeNotification,
    NSWorkspace.screensDidWakeNotification
]

for name in notifications {
    center.addObserver(forName: name, object: nil, queue: .main) { notification in
        resetPresence(reason: notification.name.rawValue)
    }
}

RunLoop.main.run()
`;
}

export function buildShutdownWatcherPlist(options: ShutdownWatcherPlistOptions): string {
  const logPath = options.logPath ?? '/tmp/agent-presence-power-watch.log';
  const errorLogPath = options.errorLogPath ?? logPath;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapePlist(options.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>${escapePlist(options.scriptPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapePlist(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlist(errorLogPath)}</string>
</dict>
</plist>
`;
}

function escapePlist(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function escapeShellDoubleQuoted(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`');
}

export function buildAgentPresenceShellCommand(args: string[]): string {
  return [...agentPresenceCommandParts(), ...args].map(shellQuote).join(' ');
}

function agentPresenceCommandParts(): string[] {
  if (process.env.AGENT_PRESENCE_HOOK_COMMAND === 'absolute') {
    return [process.execPath, resolveCliPath()];
  }
  return ['npx', '--yes', '--registry=https://registry.npmjs.org', `@rivus/agent-presence@${packageVersion()}`];
}

function resolveCliPath(): string {
  if (process.env.AGENT_PRESENCE_CLI_PATH) {
    return process.env.AGENT_PRESENCE_CLI_PATH;
  }
  for (const url of [
    new URL('./cli.js', import.meta.url),
    new URL('../cli.js', import.meta.url),
    new URL('../dist/src/cli.js', import.meta.url)
  ]) {
    const resolved = fileURLToPath(url);
    if (existsSync(resolved)) {
      return resolved;
    }
  }
  throw new Error('unable to resolve @rivus/agent-presence CLI path');
}

function packageVersion(): string {
  for (const url of [new URL('../package.json', import.meta.url), new URL('../../package.json', import.meta.url)]) {
    try {
      const parsed = JSON.parse(readFileSync(url, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.length > 0) {
        return parsed.version;
      }
    } catch {
      // Source and dist builds resolve package.json from different depths.
    }
  }
  throw new Error('unable to resolve @rivus/agent-presence package version');
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=@.-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeSwiftString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

const GEMINI_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd'
];

export function withGeminiAgentSignatureHooks(input: Partial<HookSettings>): HookSettings {
  const settings: HookSettings = {
    ...input,
    hooks: { ...(input.hooks ?? {}) }
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
