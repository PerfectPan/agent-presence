import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  installPresenceRuntime,
  presenceRuntimeCliPath,
  prunePresenceRuntimes,
  removePresenceRuntime,
  withPresenceRuntimeLock,
  type RuntimeNpmRunner
} from '../src/harness/runtime.js';
import { acquireLock } from '../src/process-lock.js';

vi.mock('../src/process-lock.js', () => ({ acquireLock: vi.fn<typeof acquireLock>() }));

let home: string;
let presenceHome: string;
const version = '1.2.3';

async function createRuntime(directory: string, installedVersion = version): Promise<void> {
  const packageRoot = join(directory, 'node_modules', '@rivus', 'agent-presence');
  await mkdir(join(packageRoot, 'dist', 'src'), { recursive: true });
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: '@rivus/agent-presence', version: installedVersion })
  );
  await writeFile(join(packageRoot, 'dist', 'src', 'cli.js'), 'process.stdout.write("runtime fixture");\n');
}

beforeEach(async () => {
  vi.mocked(acquireLock).mockReset();
  home = await mkdtemp(join(tmpdir(), 'presence-runtime-'));
  presenceHome = join(home, '.agent-presence');
  vi.stubEnv('HOME', home);
  for (const key of [
    'AGENT_PRESENCE_HOME',
    'AGENT_SIGNATURE_HOME',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'CODEX_THREAD_ID',
    'CODEX_SESSION_ID',
    'GEMINI_CLI_HOME',
    'GROK_HOME',
    'XDG_DATA_HOME',
    'PI_CODING_AGENT_DIR',
    'npm_execpath'
  ]) {
    vi.stubEnv(key, undefined);
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('presence runtime', () => {
  it('holds a bounded runtime lock outside the removable runtimes and releases it after the action', async () => {
    const order: string[] = [];
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
    const release = vi.fn<() => Promise<void>>(async () => {
      order.push('release');
    });
    vi.mocked(acquireLock).mockImplementationOnce(async (path, acquiredSignal) => {
      expect(path).toBe(join(presenceHome, 'runtime.lock.db'));
      expect(acquiredSignal).toBe(signal);
      expect((await stat(presenceHome)).mode & 0o777).toBe(0o700);
      await writeFile(path, 'lock fixture');
      order.push('acquire');
      return { path, mechanism: 'sqlite', holder: undefined, release };
    });
    const result = await withPresenceRuntimeLock(async () => {
      order.push('action');
      await createRuntime(join(presenceHome, 'runtime', version));
      await removePresenceRuntime();
      expect(await readFile(join(presenceHome, 'runtime.lock.db'), 'utf8')).toBe('lock fixture');
      return 'action result';
    });

    expect(result).toBe('action result');
    expect(timeout).toHaveBeenCalledWith(190_000);
    expect(order).toEqual(['acquire', 'action', 'release']);
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases the runtime lock when the protected action fails', async () => {
    const release = vi.fn<() => Promise<void>>(async () => {});
    vi.mocked(acquireLock).mockResolvedValueOnce({
      path: join(presenceHome, 'runtime.lock.db'),
      mechanism: 'sqlite',
      holder: undefined,
      release
    });
    const failure = new Error('runtime setup failed');

    await expect(
      withPresenceRuntimeLock(async () => {
        throw failure;
      }, presenceHome)
    ).rejects.toBe(failure);
    expect(release).toHaveBeenCalledOnce();
  });

  it('does not run the action when acquiring the runtime lock fails', async () => {
    const failure = new Error('runtime lock acquisition failed');
    vi.mocked(acquireLock).mockRejectedValueOnce(failure);
    const action = vi.fn<() => Promise<string>>(async () => 'must not run');

    await expect(withPresenceRuntimeLock(action, presenceHome)).rejects.toBe(failure);
    expect(action).not.toHaveBeenCalled();
  });

  it('installs the pinned public package into a temporary sibling before making it visible', async () => {
    const directory = join(presenceHome, 'runtime', version);
    const runNpm = vi.fn<RuntimeNpmRunner>(async (command, args) => {
      expect(command).toBe('npm');
      const temporaryDirectory = args[2]!;
      expect(dirname(temporaryDirectory)).toBe(dirname(directory));
      expect(temporaryDirectory).not.toBe(directory);
      await expect(
        readFile(join(directory, 'node_modules', '@rivus', 'agent-presence', 'package.json'))
      ).rejects.toThrow(/ENOENT/);
      expect(args).toEqual([
        'install',
        '--prefix',
        temporaryDirectory,
        '--registry=https://registry.npmjs.org',
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
        '@rivus/agent-presence@1.2.3'
      ]);
      await createRuntime(temporaryDirectory);
    });

    expect(await installPresenceRuntime(undefined, { version, runNpm })).toEqual({
      version,
      directory,
      cliPath: presenceRuntimeCliPath(version, presenceHome),
      reused: false
    });
    expect(runNpm).toHaveBeenCalledOnce();
    expect((await readdir(dirname(directory))).sort()).toEqual([version]);
    expect(await readFile(presenceRuntimeCliPath(version, presenceHome), 'utf8')).toContain('runtime fixture');
  });

  it('reuses a runtime only when the package version and CLI file are valid', async () => {
    const directory = join(presenceHome, 'runtime', version);
    await createRuntime(directory);
    const runNpm = vi.fn<RuntimeNpmRunner>();

    expect(await installPresenceRuntime(presenceHome, { version, runNpm })).toMatchObject({ directory, reused: true });
    expect(runNpm).not.toHaveBeenCalled();
  });

  it.each(['version', 'package', 'cli'] as const)(
    'replaces a corrupt runtime with an invalid %s',
    async (corruption) => {
      const directory = join(presenceHome, 'runtime', version);
      await createRuntime(directory, corruption === 'version' ? '9.9.9' : version);
      const packageRoot = join(directory, 'node_modules', '@rivus', 'agent-presence');
      if (corruption === 'package') {
        await writeFile(join(packageRoot, 'package.json'), 'invalid JSON');
      } else if (corruption === 'cli') {
        await rm(join(packageRoot, 'dist', 'src', 'cli.js'));
        await mkdir(join(packageRoot, 'dist', 'src', 'cli.js'));
      }
      const runNpm = vi.fn<RuntimeNpmRunner>(async (_command, args) => {
        await createRuntime(args[2]!);
      });

      expect(await installPresenceRuntime(presenceHome, { version, runNpm })).toMatchObject({
        directory,
        reused: false
      });
      expect(runNpm).toHaveBeenCalledOnce();
      expect(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))).toEqual({
        name: '@rivus/agent-presence',
        version
      });
      expect(await readFile(join(packageRoot, 'dist', 'src', 'cli.js'), 'utf8')).toContain('runtime fixture');
      expect((await readdir(dirname(directory))).sort()).toEqual([version]);
    }
  );

  it('uses the invoking npm CLI script through the setup node and ignores a different package manager', async () => {
    const npmCli = join(home, 'npm', 'bin', 'npm-cli.js');
    await mkdir(dirname(npmCli), { recursive: true });
    await writeFile(npmCli, 'npm fixture');
    vi.stubEnv('npm_execpath', npmCli);
    const npmRunner = vi.fn<RuntimeNpmRunner>(async (_command, args) => {
      await createRuntime(args[3]!);
    });
    await installPresenceRuntime(presenceHome, { version, runNpm: npmRunner });
    expect(npmRunner.mock.calls[0]?.[0]).toBe(process.execPath);
    expect(npmRunner.mock.calls[0]?.[1]?.[0]).toBe(npmCli);

    await removePresenceRuntime(presenceHome);
    vi.stubEnv('npm_execpath', join(home, 'pnpm.cjs'));
    const pathRunner = vi.fn<RuntimeNpmRunner>(async (_command, args) => {
      await createRuntime(args[2]!);
    });
    await installPresenceRuntime(presenceHome, { version, runNpm: pathRunner });
    expect(pathRunner.mock.calls[0]?.[0]).toBe('npm');

    await removePresenceRuntime(presenceHome);
    vi.stubEnv('npm_execpath', join(home, 'missing', 'npm-cli.js'));
    await installPresenceRuntime(presenceHome, { version, runNpm: pathRunner });
    expect(pathRunner.mock.calls[1]?.[0]).toBe('npm');

    await removePresenceRuntime(presenceHome);
    const npmDirectory = join(home, 'directory', 'npm-cli.js');
    await mkdir(npmDirectory, { recursive: true });
    vi.stubEnv('npm_execpath', npmDirectory);
    await installPresenceRuntime(presenceHome, { version, runNpm: pathRunner });
    expect(pathRunner.mock.calls[2]?.[0]).toBe('npm');
  });

  it('cleans the temporary install and preserves an existing runtime when npm fails', async () => {
    const directory = join(presenceHome, 'runtime', version);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'keep'), 'old incomplete runtime');
    const runNpm = vi.fn<RuntimeNpmRunner>(async (_command, args) => {
      await createRuntime(args[2]!);
      throw new Error('registry offline');
    });

    await expect(installPresenceRuntime(presenceHome, { version, runNpm })).rejects.toThrow('registry offline');
    expect((await readdir(join(presenceHome, 'runtime'))).sort()).toEqual([version]);
    expect(await readFile(join(directory, 'keep'), 'utf8')).toBe('old incomplete runtime');
    await expect(readFile(join(presenceHome, 'bin', 'agent-presence'))).rejects.toThrow(/ENOENT/);
  });

  it('rejects incomplete npm output and invalid version paths without publishing a runtime', async () => {
    const runNpm = vi.fn<RuntimeNpmRunner>(async (_command, args) => {
      await createRuntime(args[2]!, '9.9.9');
    });
    await expect(installPresenceRuntime(presenceHome, { version, runNpm })).rejects.toThrow(
      'npm did not install a valid'
    );
    expect((await readdir(join(presenceHome, 'runtime'))).sort()).toEqual([]);
    runNpm.mockClear();
    await expect(installPresenceRuntime(presenceHome, { version: '../outside', runNpm })).rejects.toThrow(/Invalid/);
    expect(runNpm).not.toHaveBeenCalled();
    await expect(readFile(join(home, 'outside'))).rejects.toThrow(/ENOENT/);
  });

  it('keeps the current and previous shim versions while pruning older runtime directories', async () => {
    for (const installedVersion of ['1.2.1', '1.2.2', version]) {
      await createRuntime(join(presenceHome, 'runtime', installedVersion), installedVersion);
    }
    await writeFile(join(presenceHome, 'runtime', 'keep'), 'unrelated');

    await prunePresenceRuntimes(version, '1.2.2', presenceHome);
    expect((await readdir(join(presenceHome, 'runtime'))).sort()).toEqual(['1.2.2', version, 'keep']);
    await prunePresenceRuntimes(version, undefined, presenceHome);
    expect((await readdir(join(presenceHome, 'runtime'))).sort()).toEqual([version, 'keep']);
  });

  it('preserves a runtime currently selected by another setup while pruning older versions', async () => {
    for (const installedVersion of ['1.2.0', '1.2.1', '1.2.2', version]) {
      await createRuntime(join(presenceHome, 'runtime', installedVersion), installedVersion);
    }

    await prunePresenceRuntimes('1.2.2', '1.2.1', presenceHome, version);

    expect((await readdir(join(presenceHome, 'runtime'))).sort()).toEqual(['1.2.1', '1.2.2', version]);
  });

  it('removes interrupted installation directories when pruning runtimes', async () => {
    await createRuntime(join(presenceHome, 'runtime', version));
    for (const temporaryName of ['.install-interrupted', '.install-incomplete']) {
      const temporaryDirectory = join(presenceHome, 'runtime', temporaryName);
      await mkdir(temporaryDirectory);
      await writeFile(join(temporaryDirectory, 'package.json'), 'incomplete install');
    }

    await prunePresenceRuntimes(version, undefined, presenceHome);

    expect((await readdir(join(presenceHome, 'runtime'))).sort()).toEqual([version]);
  });

  it('removes the whole runtime independently and accepts absent runtime directories', async () => {
    await prunePresenceRuntimes(version, undefined, presenceHome);
    await createRuntime(join(presenceHome, 'runtime', version));
    await writeFile(join(presenceHome, 'keep'), 'unrelated');
    await removePresenceRuntime();
    await removePresenceRuntime();

    await expect(readdir(join(presenceHome, 'runtime'))).rejects.toThrow(/ENOENT/);
    expect(await readFile(join(presenceHome, 'keep'), 'utf8')).toBe('unrelated');
  });
});
