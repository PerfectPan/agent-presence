import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

export const DEFAULT_SETUP_SCRIPT_NAMES = [
  'install-codex-hook.js',
  'install-claude-hook.js',
  'install-opencode-plugin.js',
  'install-shutdown-watcher.js'
] as const;

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
  const scriptNames = options.scriptNames ?? DEFAULT_SETUP_SCRIPT_NAMES;
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

function defaultResolveScriptPath(scriptName: string): string {
  return fileURLToPath(new URL(`../scripts/${scriptName}`, import.meta.url));
}

async function defaultRunner(scriptPath: string): Promise<void> {
  await execFileAsync(process.execPath, [scriptPath], { env: process.env });
}
