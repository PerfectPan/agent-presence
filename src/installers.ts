import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasNodeErrorCode } from './json-file.js';
import { packageVersion } from './package-version.js';
import { shellQuote } from './shell-quote.js';

async function readManagedExtension(
  path: string,
  marker: string
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

// ---------------------------------------------------------------------------
// dsh (DeepSeek harness) plugin
//
// dsh has no managed hook settings of its own; its extension surface is
// Cordis plugins. We ship a single-file plugin that bridges dsh lifecycle
// events and per-call token usage into `agent-presence hook --source dsh`,
// and register it in the home-level `~/.dsh/cordis.patch.yml` (which applies
// to every profile). The patch is a top-level YAML array; we merge our entry
// as a marker-delimited block so uninstall is a clean text removal.
// ---------------------------------------------------------------------------

export const DSH_PLUGIN_FILE_NAME = 'agent-presence.mjs';
export const DSH_PLUGIN_MARKER = '@rivus/agent-presence dsh plugin';

const DSH_PATCH_START = '# agent-presence-dsh-plugin:start';
const DSH_PATCH_END = '# agent-presence-dsh-plugin:end';

export interface DshPluginPaths {
  /** Where the single-file plugin is written (e.g. `~/.dsh/plugins/agent-presence.mjs`). */
  pluginPath: string;
  /** The home-level cordis patch that registers it (e.g. `~/.dsh/cordis.patch.yml`). */
  patchPath: string;
}

/** Resolve the dsh plugin + patch paths, honouring `DSH_HOME` and test overrides. */
export function resolveDshPluginPaths(): DshPluginPaths {
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  return {
    pluginPath: process.env.DSH_AGENT_PRESENCE_PLUGIN_FILE ?? join(dshHome, 'plugins', DSH_PLUGIN_FILE_NAME),
    patchPath: process.env.DSH_AGENT_PRESENCE_PATCH_FILE ?? join(dshHome, 'cordis.patch.yml')
  };
}

export interface DshInstallResult {
  status: 'installed';
  pluginPath: string;
  patchPath: string;
  patchUpdated: boolean;
  patchError?: string;
}

export interface DshUninstallResult {
  status: 'removed' | 'skipped';
  pluginPath: string;
  patchPath: string;
  patchUpdated: boolean;
  patchError?: string;
}

/** Remove the agent-presence entry from a cordis.patch.yml body. */
export function withoutDshAgentPresencePatch(input: string): string {
  const startIdx = input.indexOf(DSH_PATCH_START);
  if (startIdx === -1) {
    return input;
  }
  const endIdx = input.indexOf(DSH_PATCH_END, startIdx);
  if (endIdx === -1) {
    return input;
  }
  const before = input.slice(0, startIdx);
  const after = input.slice(endIdx + DSH_PATCH_END.length);
  // Only normalize the gap left by the removed block, not the file's own spacing.
  const result = `${before.replace(/\n+$/, '')}\n\n${after.replace(/^\n+/, '')}`.trim();
  return result ? `${result}\n` : '';
}

function dshPluginBlock(pluginPath: string): string {
  return `${DSH_PATCH_START}
- insert:
    - id: agent-presence
      name: ${pluginPath}
${DSH_PATCH_END}`;
}

/** Merge the agent-presence entry into a home-level cordis.patch.yml body. */
export function withDshAgentPresencePatch(input: string, pluginPath: string): string {
  const block = dshPluginBlock(pluginPath);
  const startIdx = input.indexOf(DSH_PATCH_START);
  if (startIdx === -1) {
    const trimmed = input.trimEnd();
    return trimmed ? `${trimmed}\n${block}\n` : `${block}\n`;
  }
  // Replace from the start marker to the end marker (or EOF if the end marker
  // is missing — a crash mid-write left an orphaned start).
  const endIdx = input.indexOf(DSH_PATCH_END, startIdx);
  const endSlice = endIdx === -1 ? input.length : endIdx + DSH_PATCH_END.length;
  return `${input.slice(0, startIdx)}${block}${input.slice(endSlice)}`;
}

async function readTextFile(path: string, fallback: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) {
      return fallback;
    }
    throw error;
  }
}

export async function uninstallDshPlugin(paths: DshPluginPaths): Promise<DshUninstallResult> {
  const existing = await readManagedExtension(paths.pluginPath, DSH_PLUGIN_MARKER);
  let status: DshUninstallResult['status'] = 'skipped';
  if (existing.status === 'managed') {
    await rm(paths.pluginPath, { force: true });
    status = 'removed';
  }

  let patchUpdated = false;
  let patchError: string | undefined;
  try {
    const patch = await readTextFile(paths.patchPath, '');
    const next = withoutDshAgentPresencePatch(patch);
    if (next) {
      await writeFile(paths.patchPath, next, { mode: 0o600 });
    } else {
      await rm(paths.patchPath, { force: true });
    }
    patchUpdated = true;
  } catch (error) {
    patchError = describeInstallerError(error);
  }

  return { status, pluginPath: paths.pluginPath, patchPath: paths.patchPath, patchUpdated, patchError };
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

function agentPresenceCommandParts(): string[] {
  if (process.env.AGENT_PRESENCE_HOOK_COMMAND === 'absolute') {
    return [process.execPath, resolveCliPath()];
  }
  return ['npx', '--yes', '--registry=https://registry.npmjs.org', `@rivus/agent-presence@${packageVersion()}`];
}

function buildDshPluginSource(commandParts = agentPresenceCommandParts()): string {
  return `// ${DSH_PLUGIN_MARKER}
//
// Bridges dsh (DeepSeek harness) lifecycle and token usage into
// @rivus/agent-presence so dsh appears in the presence renderer and its
// token usage feeds the usage stats. Active state is driven by dsh's own
// lifecycle events; we never scan processes or terminal windows.
//
// Generated by \`agent-presence setup\`. Do not edit by hand. Re-running
// setup overwrites this file; \`agent-presence uninstall\` removes it.
import { spawn, spawnSync } from "node:child_process"

const CLI_COMMAND = ${JSON.stringify(commandParts)}
const SOURCE = "dsh"

let lastSession

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

function sessionFromAgent(agent) {
  const session = agent?.session
  const id = firstString(session?.header?.id, session?.id)
  if (!id) return undefined
  return { session_id: id, cwd: firstString(session?.header?.cwd) ?? process.cwd() }
}

function emit(event, payload, sync) {
  if (!payload?.session_id) return
  const body = JSON.stringify({ event, ...payload })
  const args = [...CLI_COMMAND.slice(1), "hook", "--source", SOURCE, "--event", event, "--silent"]
  if (sync) {
    try {
      spawnSync(CLI_COMMAND[0], args, {
        input: body,
        encoding: "utf8",
        timeout: 5000,
        stdio: ["pipe", "ignore", "ignore"],
      })
    } catch (_) {
      // Never let presence telemetry break dsh.
    }
    return
  }
  try {
    const child = spawn(CLI_COMMAND[0], args, {
      stdio: ["pipe", "ignore", "ignore"],
      detached: true,
    })
    child.stdin.end(body)
    child.unref()
    child.on("error", () => {})
  } catch (_) {
    // Never let presence telemetry break dsh.
  }
}

export const name = "agent-presence"

export function apply(ctx) {
  ctx.on("agent/session-start", (payload) => {
    const session = sessionFromAgent(payload?.agent)
    if (!session) return
    lastSession = session
    emit("SessionStart", session, false)
  })

  // waterfall: must delegate to next() so the step proceeds.
  ctx.on("agent/pre-step", async (payload, next) => {
    const session = sessionFromAgent(payload?.agent) ?? lastSession
    if (session) {
      lastSession = session
      emit("Heartbeat", session, false)
    }
    return next()
  })

  // One heartbeat per tool call (on completion) is enough to prove the
  // session is active; agent/pre-step already covers step starts.
  ctx.on("tools/result", () => {
    if (lastSession) emit("Heartbeat", lastSession, false)
  })

  ctx.on("session/event", (session, event) => {
    if (event?.type !== "assistant/message") return
    const usage = event.data?.usage
    if (!usage) return
    // Subagent sessions report their own usage; only the main session feeds
    // the aggregate (subagent turns are part of the main agent's work).
    if (session?.header?.origin === "subagent") return
    const id = firstString(session?.header?.id, session?.id)
    if (!id) return
    emit("Heartbeat", {
      session_id: id,
      cwd: firstString(session?.header?.cwd) ?? process.cwd(),
      model: firstString(event.data.message?.source?.model),
      usage: {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      },
    }, false)
  })

  ctx.on("agent/turn-stopping", (payload) => {
    const session = sessionFromAgent(payload?.agent) ?? lastSession
    if (!session) return
    // Sync so a one-shot (headless) dsh run still delivers Stop before exit.
    emit("Stop", session, true)
  })
}
`;
}

export async function installDshPlugin(paths: DshPluginPaths): Promise<DshInstallResult> {
  await mkdir(dirname(paths.pluginPath), { recursive: true, mode: 0o700 });
  const existing = await readManagedExtension(paths.pluginPath, DSH_PLUGIN_MARKER);
  if (existing.status === 'unmanaged') {
    throw new Error(
      `refusing to overwrite ${paths.pluginPath}: it is not managed by @rivus/agent-presence. ` +
        'Delete or rename that file, then rerun setup.'
    );
  }
  await writeFile(paths.pluginPath, buildDshPluginSource(), { mode: 0o600 });

  let patchUpdated = false;
  let patchError: string | undefined;
  try {
    const patch = await readTextFile(paths.patchPath, '');
    await writeFile(paths.patchPath, withDshAgentPresencePatch(patch, paths.pluginPath), { mode: 0o600 });
    patchUpdated = true;
  } catch (error) {
    patchError = describeInstallerError(error);
  }

  return { status: 'installed', pluginPath: paths.pluginPath, patchPath: paths.patchPath, patchUpdated, patchError };
}

export function buildAgentPresenceShellCommand(args: string[]): string {
  return [...agentPresenceCommandParts(), ...args].map(shellQuote).join(' ');
}
