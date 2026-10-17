import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import * as z from 'zod/mini';
import { getHomeDir } from '../config.js';
import { hasNodeErrorCode } from '../json-file.js';
import { packageVersion } from '../package-version.js';
import { acquireLock } from '../process-lock.js';

const versionSchema = z.string().check(z.regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/));
const installedPackageSchema = z.object({
  name: z.literal('@rivus/agent-presence'),
  version: versionSchema
});
const execFileAsync = promisify(execFile);

export type RuntimeNpmRunner = (command: string, args: string[]) => Promise<void>;

export interface RuntimeInstallOptions {
  version?: string;
  runNpm?: RuntimeNpmRunner;
}

export interface PresenceRuntime {
  version: string;
  directory: string;
  cliPath: string;
  reused: boolean;
}

export async function withPresenceRuntimeLock<A>(action: () => Promise<A>, home = getHomeDir()): Promise<A> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const lock = await acquireLock(join(home, 'runtime.lock.db'), AbortSignal.timeout(190_000));
  try {
    return await action();
  } finally {
    await lock.release();
  }
}

export function presenceRuntimeCliPath(version = packageVersion(), home = getHomeDir()): string {
  return join(
    home,
    'runtime',
    versionSchema.parse(version),
    'node_modules',
    '@rivus',
    'agent-presence',
    'dist',
    'src',
    'cli.js'
  );
}

async function validRuntime(directory: string, version: string): Promise<boolean> {
  const packageRoot = join(directory, 'node_modules', '@rivus', 'agent-presence');
  try {
    const pkg = installedPackageSchema.parse(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')));
    return pkg.version === version && (await stat(join(packageRoot, 'dist', 'src', 'cli.js'))).isFile();
  } catch {
    return false;
  }
}

const runNpm: RuntimeNpmRunner = async (command, args) => {
  await execFileAsync(command, args, { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
};

export async function installPresenceRuntime(
  home = getHomeDir(),
  options: RuntimeInstallOptions = {}
): Promise<PresenceRuntime> {
  const version = versionSchema.parse(options.version ?? packageVersion());
  const runtimeRoot = join(home, 'runtime');
  const directory = join(runtimeRoot, version);
  const cliPath = presenceRuntimeCliPath(version, home);
  if (await validRuntime(directory, version)) {
    return { version, directory, cliPath, reused: true };
  }

  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const temporaryDirectory = await mkdtemp(join(runtimeRoot, '.install-'));
  try {
    const args = [
      'install',
      '--prefix',
      temporaryDirectory,
      '--registry=https://registry.npmjs.org',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      `@rivus/agent-presence@${version}`
    ];
    const npmCli = process.env.npm_execpath;
    const npmCliExists =
      npmCli &&
      basename(npmCli) === 'npm-cli.js' &&
      (await stat(npmCli).then(
        (file) => file.isFile(),
        () => false
      ));
    if (npmCliExists) {
      await (options.runNpm ?? runNpm)(process.execPath, [npmCli, ...args]);
    } else {
      await (options.runNpm ?? runNpm)('npm', args);
    }
    if (!(await validRuntime(temporaryDirectory, version))) {
      throw new Error(`npm did not install a valid @rivus/agent-presence@${version} runtime`);
    }
    if (await validRuntime(directory, version)) {
      return { version, directory, cliPath, reused: true };
    }
    await rm(directory, { recursive: true, force: true });
    await rename(temporaryDirectory, directory);
    return { version, directory, cliPath, reused: false };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function prunePresenceRuntimes(
  currentVersion: string,
  previousVersion?: string,
  home = getHomeDir(),
  selectedVersion?: string
): Promise<void> {
  const keep = new Set([versionSchema.parse(currentVersion)]);
  for (const version of [previousVersion, selectedVersion]) {
    if (version !== undefined) {
      keep.add(versionSchema.parse(version));
    }
  }
  const runtimeRoot = join(home, 'runtime');
  let entries;
  try {
    entries = await readdir(runtimeRoot, { withFileTypes: true });
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !keep.has(entry.name)) {
      await rm(join(runtimeRoot, entry.name), { recursive: true, force: true });
    }
  }
}

export async function removePresenceRuntime(home = getHomeDir()): Promise<void> {
  await rm(join(home, 'runtime'), { recursive: true, force: true });
}
