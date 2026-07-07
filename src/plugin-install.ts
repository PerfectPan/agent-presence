import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getPluginsDir } from './config.js';
import { hasNodeErrorCode } from './json-file.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_PLUGIN_REGISTRY = 'https://registry.npmjs.org';

export interface InstallPluginOptions {
  /** npm registry to install from; defaults to the public registry. */
  registry?: string;
  /** Directory to install into; defaults to the plugins dir. */
  pluginsDir?: string;
  /** Injected for tests. Runs `npm` with the given args in `cwd`. */
  runner?: (args: string[], cwd: string) => Promise<void>;
}

export interface InstalledPlugin {
  /** The resolved package name (npm may normalize the requested spec). */
  packageName: string;
  /** The version npm resolved and installed. */
  version: string;
}

/**
 * Install a source-plugin npm package into the isolated plugins dir. The
 * package lands under `<pluginsDir>/node_modules`, separate from the CLI's own
 * install and from any project the user is in. Returns the installed package's
 * name and version so the caller can record the source entry.
 */
export async function installPluginPackage(spec: string, options: InstallPluginOptions = {}): Promise<InstalledPlugin> {
  const pluginsDir = options.pluginsDir ?? getPluginsDir();
  const registry = options.registry ?? DEFAULT_PLUGIN_REGISTRY;
  const runner = options.runner ?? defaultNpmRunner;

  await mkdir(pluginsDir, { recursive: true, mode: 0o700 });
  await ensurePluginsPackageJson(pluginsDir);

  await runner(
    ['install', spec, '--save', '--registry', registry, '--no-audit', '--no-fund', '--ignore-scripts'],
    pluginsDir
  );

  return readInstalledPackage(pluginsDir, spec);
}

/** Remove an installed source-plugin package from the plugins dir. */
export async function uninstallPluginPackage(packageName: string, options: InstallPluginOptions = {}): Promise<void> {
  const pluginsDir = options.pluginsDir ?? getPluginsDir();
  const runner = options.runner ?? defaultNpmRunner;
  await runner(['uninstall', packageName, '--no-audit', '--no-fund', '--ignore-scripts'], pluginsDir);
}

/**
 * The package name npm would install for a spec, minus any version/tag/range
 * (e.g. `@scope/pkg@1.2.3` -> `@scope/pkg`, `pkg@next` -> `pkg`). Used to key
 * config entries and locate the installed package.json.
 */
export function packageNameFromSpec(spec: string): string {
  const scoped = spec.startsWith('@');
  const at = spec.indexOf('@', scoped ? 1 : 0);
  return at > 0 ? spec.slice(0, at) : spec;
}

async function ensurePluginsPackageJson(pluginsDir: string): Promise<void> {
  const pkgPath = join(pluginsDir, 'package.json');
  try {
    await readFile(pkgPath, 'utf8');
  } catch (error) {
    if (!hasNodeErrorCode(error, 'ENOENT')) {
      throw error;
    }
    await writeFile(
      pkgPath,
      `${JSON.stringify({ name: 'agent-presence-plugins', private: true, description: 'agent-presence installed source plugins' }, null, 2)}\n`,
      { mode: 0o600 }
    );
  }
}

async function readInstalledPackage(pluginsDir: string, spec: string): Promise<InstalledPlugin> {
  const packageName = packageNameFromSpec(spec);
  const pkgPath = join(pluginsDir, 'node_modules', packageName, 'package.json');
  const parsed = JSON.parse(await readFile(pkgPath, 'utf8')) as { name?: unknown; version?: unknown };
  return {
    packageName: typeof parsed.name === 'string' ? parsed.name : packageName,
    version: typeof parsed.version === 'string' ? parsed.version : 'unknown'
  };
}

async function defaultNpmRunner(args: string[], cwd: string): Promise<void> {
  try {
    await execFileAsync('npm', args, { cwd, env: process.env });
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) {
      throw new Error('npm was not found in PATH; install Node.js/npm to add source plugins by package name.');
    }
    throw new Error(`npm ${args[0]} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Remove the whole plugins dir (used by `uninstall --all`). */
export async function removePluginsDir(pluginsDir = getPluginsDir()): Promise<void> {
  await rm(pluginsDir, { recursive: true, force: true });
}
