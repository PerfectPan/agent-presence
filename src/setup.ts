import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isMacOS } from './platform.js';

const execFileAsync = promisify(execFile);

const WATCHER_INSTALL_SCRIPT = 'install-shutdown-watcher.js';
const WATCHER_UNINSTALL_SCRIPT = 'uninstall-shutdown-watcher.js';

export const DEFAULT_SETUP_SCRIPT_NAMES = [
  'install-codex-hook.js',
  'install-claude-hook.js',
  'install-opencode-plugin.js',
  'install-gemini-hook.js',
  WATCHER_INSTALL_SCRIPT
] as const;

export const DEFAULT_UNINSTALL_SCRIPT_NAMES = [
  'uninstall-codex-hook.js',
  'uninstall-claude-hook.js',
  'uninstall-opencode-plugin.js',
  'uninstall-gemini-hook.js',
  WATCHER_UNINSTALL_SCRIPT
] as const;

export const LINUX_WATCHER_SKIP_MESSAGE =
  'agent-presence: skipping power watcher on linux (no reliable systemd/logind path); TTL pruning still covers expired sessions.';

export function platformSetupScriptNames(platform: NodeJS.Platform = process.platform): readonly string[] {
  if (isMacOS(platform)) {
    return DEFAULT_SETUP_SCRIPT_NAMES;
  }
  return DEFAULT_SETUP_SCRIPT_NAMES.filter((name) => name !== WATCHER_INSTALL_SCRIPT);
}

export function platformUninstallScriptNames(platform: NodeJS.Platform = process.platform): readonly string[] {
  if (isMacOS(platform)) {
    return DEFAULT_UNINSTALL_SCRIPT_NAMES;
  }
  return DEFAULT_UNINSTALL_SCRIPT_NAMES.filter((name) => name !== WATCHER_UNINSTALL_SCRIPT);
}

export interface SetupScriptResult {
  scriptName: string;
  scriptPath: string;
}

export interface RunSetupScriptsOptions {
  scriptNames?: readonly string[];
  resolveScriptPath?: (scriptName: string) => string;
  runner?: (scriptPath: string) => Promise<void>;
}

export async function runSetupScripts(options: RunSetupScriptsOptions = {}): Promise<SetupScriptResult[]> {
  const scriptNames = options.scriptNames ?? platformSetupScriptNames();
  const resolveScriptPath = options.resolveScriptPath ?? defaultResolveScriptPath;
  const runner = options.runner ?? defaultRunner;
  const results: SetupScriptResult[] = [];

  for (const scriptName of scriptNames) {
    const scriptPath = resolveScriptPath(scriptName);
    await runner(scriptPath);
    results.push({ scriptName, scriptPath });
  }

  return results;
}

export async function runUninstallScripts(options: RunSetupScriptsOptions = {}): Promise<SetupScriptResult[]> {
  return runSetupScripts({
    ...options,
    scriptNames: options.scriptNames ?? platformUninstallScriptNames()
  });
}

function defaultResolveScriptPath(scriptName: string): string {
  return fileURLToPath(new URL(`../scripts/${scriptName}`, import.meta.url));
}

async function defaultRunner(scriptPath: string): Promise<void> {
  await execFileAsync(process.execPath, [scriptPath], { env: process.env });
}
