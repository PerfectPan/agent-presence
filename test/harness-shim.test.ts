import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import * as z from 'zod/mini';
import { createPresenceBundle } from '../src/harness/bundle.js';
import { presenceRuntimeCliPath } from '../src/harness/runtime.js';
import {
  readPresenceShimRuntimeVersion,
  removePresenceShim,
  resolveHookCommandMode,
  writePresenceShim
} from '../src/harness/shim.js';
import { shellQuote } from '../src/shell-quote.js';

const shimIo = vi.hoisted(() => ({
  failWrite: false,
  beforeRename: undefined as ((source: string, target: string) => Promise<void>) | undefined
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    writeFile: async (...args: Parameters<typeof original.writeFile>) => {
      await original.writeFile(...args);
      if (shimIo.failWrite) {
        throw new Error('shim write blocked by the test');
      }
    },
    rename: async (...args: Parameters<typeof original.rename>) => {
      await shimIo.beforeRename?.(String(args[0]), String(args[1]));
      return original.rename(...args);
    }
  };
});

let home: string;
let presenceHome: string;
let shimPath: string;
const originalExecPath = process.execPath;
const execFileAsync = promisify(execFile);

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'presence-shim-'));
  presenceHome = join(home, '.agent-presence');
  shimPath = join(presenceHome, 'bin', 'agent-presence');
  vi.stubEnv('HOME', home);
  for (const key of [
    'AGENT_PRESENCE_HOME',
    'AGENT_SIGNATURE_HOME',
    'AGENT_PRESENCE_HOOK_COMMAND',
    'AGENT_PRESENCE_CLI_PATH',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'CODEX_THREAD_ID',
    'CODEX_SESSION_ID',
    'GEMINI_CLI_HOME',
    'GROK_HOME',
    'XDG_DATA_HOME',
    'PI_CODING_AGENT_DIR'
  ]) {
    vi.stubEnv(key, undefined);
  }
});

afterEach(async () => {
  shimIo.failWrite = false;
  shimIo.beforeRename = undefined;
  process.execPath = originalExecPath;
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('presence harness shim', () => {
  it('writes an executable default-home shim pointing at the pinned installed runtime', async () => {
    const pkg = z.parse(
      z.object({ version: z.string() }),
      JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    );

    expect(await writePresenceShim()).toBe(shimPath);
    expect(await readFile(shimPath, 'utf8')).toBe(
      `#!/bin/sh\n# agent-presence runtime-version: ${pkg.version}\nif [ -f ${shellQuote(originalExecPath)} ]; then\n  exec ${shellQuote(originalExecPath)} ${presenceRuntimeCliPath(pkg.version, presenceHome)} "$@"\nfi\nexec node ${presenceRuntimeCliPath(pkg.version, presenceHome)} "$@"\n`
    );
    expect((await stat(shimPath)).mode & 0o777).toBe(0o755);
    expect((await readdir(dirname(shimPath))).sort()).toEqual(['agent-presence']);
  });

  it('atomically replaces the shim in the configured home with shell-quoted absolute parts and a stable bundle command', async () => {
    presenceHome = join(home, 'presence home');
    shimPath = join(presenceHome, 'bin', 'agent-presence');
    vi.stubEnv('AGENT_PRESENCE_HOME', presenceHome);
    await writePresenceShim();
    await chmod(shimPath, 0o600);
    const previous = await readFile(shimPath, 'utf8');
    const bundleBefore = createPresenceBundle();
    process.execPath = '/work/node bin/node';
    vi.stubEnv('AGENT_PRESENCE_HOOK_COMMAND', 'absolute');
    vi.stubEnv('AGENT_PRESENCE_CLI_PATH', "/work/presence's checkout/$runtime/dist/src/cli.js");
    const expected = `#!/bin/sh\nif [ -f '/work/node bin/node' ]; then\n  exec '/work/node bin/node' '/work/presence'\\''s checkout/$runtime/dist/src/cli.js' "$@"\nfi\nexec node '/work/presence'\\''s checkout/$runtime/dist/src/cli.js' "$@"\n`;
    const beforeRename = vi.fn<(source: string, target: string) => Promise<void>>(async (source, target) => {
      expect(dirname(source)).toBe(dirname(shimPath));
      expect(source).not.toBe(shimPath);
      expect(target).toBe(shimPath);
      expect(await readFile(shimPath, 'utf8')).toBe(previous);
      expect(await readFile(source, 'utf8')).toBe(expected);
      expect((await stat(source)).mode & 0o777).toBe(0o755);
    });
    shimIo.beforeRename = beforeRename;

    expect(await writePresenceShim()).toBe(shimPath);
    expect(beforeRename).toHaveBeenCalledOnce();
    expect(await readFile(shimPath, 'utf8')).toBe(expected);
    expect((await stat(shimPath)).mode & 0o777).toBe(0o755);
    expect(createPresenceBundle()).toEqual(bundleBefore);
    expect((await readdir(dirname(shimPath))).sort()).toEqual(['agent-presence']);
  });

  it('preserves the existing shim and removes the temporary file when writing fails', async () => {
    await mkdir(dirname(shimPath), { recursive: true });
    const previous = '#!/bin/sh\nexec previous "$@"\n';
    await writeFile(shimPath, previous, { mode: 0o600 });
    shimIo.failWrite = true;

    await expect(writePresenceShim()).rejects.toThrow('shim write blocked by the test');
    expect(await readFile(shimPath, 'utf8')).toBe(previous);
    expect((await stat(shimPath)).mode & 0o777).toBe(0o600);
    expect((await readdir(dirname(shimPath))).sort()).toEqual(['agent-presence']);
  });

  it('removes only the shim and accepts an already absent shim', async () => {
    await writePresenceShim();
    const unrelated = join(dirname(shimPath), 'keep');
    await writeFile(unrelated, 'unrelated');

    await removePresenceShim();
    await removePresenceShim();

    await expect(readFile(shimPath, 'utf8')).rejects.toThrow(/ENOENT/);
    expect(await readFile(unrelated, 'utf8')).toBe('unrelated');
    expect((await readdir(dirname(shimPath))).sort()).toEqual(['keep']);
  });

  it('normalizes package, npx alias and absolute modes', async () => {
    expect(resolveHookCommandMode()).toBe('package');
    expect(resolveHookCommandMode('package')).toBe('package');
    expect(resolveHookCommandMode('npx')).toBe('package');
    expect(resolveHookCommandMode('absolute')).toBe('absolute');
    await writePresenceShim(undefined, { mode: 'npx' });
    expect(await readPresenceShimRuntimeVersion()).toBeDefined();
    expect(await readFile(shimPath, 'utf8')).not.toContain('npx');
  });

  it('reports an invalid hook command mode in one line naming the allowed values', () => {
    const expected = /^invalid --hook-command: expected package, npx, or absolute$/;
    expect(() => resolveHookCommandMode('unsupported')).toThrow(expected);
    vi.stubEnv('AGENT_PRESENCE_HOOK_COMMAND', 'unsupported');
    expect(() => resolveHookCommandMode()).toThrow(expected);
  });

  it.each(['installed', 'missing'] as const)(
    'executes the CLI with the baked node %s and forwards shell-sensitive arguments',
    async (nodeState) => {
      presenceHome = join(home, "presence's home $runtime");
      shimPath = join(presenceHome, 'bin', 'agent-presence');
      const cliPath = presenceRuntimeCliPath('1.2.3', presenceHome);
      await mkdir(dirname(cliPath), { recursive: true });
      await writeFile(cliPath, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
      const nodeBin = join(home, 'path bin');
      await mkdir(nodeBin);
      await symlink(originalExecPath, join(nodeBin, 'node'));
      const nodePath = join(home, "node's $runtime");
      if (nodeState === 'installed') {
        await symlink(originalExecPath, nodePath);
      }
      await writePresenceShim(presenceHome, { version: '1.2.3', nodePath });

      const args = ['--help', 'space value', "quote's value", '$runtime', '$(exit 7)'];
      const result = await execFileAsync('/bin/sh', [shimPath, ...args], {
        env: { ...process.env, PATH: nodeState === 'installed' ? '' : nodeBin }
      });
      expect(JSON.parse(result.stdout)).toEqual(args);
      expect(result.stderr).toBe('');
    }
  );

  it('reads only a runtime version that the previous shim actually points at', async () => {
    expect(await readPresenceShimRuntimeVersion()).toBeUndefined();
    await writePresenceShim(undefined, { version: '1.2.3-rc.1' });
    expect(await readPresenceShimRuntimeVersion()).toBe('1.2.3-rc.1');

    await writePresenceShim(undefined, { mode: 'absolute', cliPath: '/work/checkout/dist/src/cli.js' });
    expect(await readPresenceShimRuntimeVersion()).toBeUndefined();
    await writeFile(shimPath, '#!/bin/sh\nexec npx @rivus/agent-presence@0.10.0 "$@"\n');
    expect(await readPresenceShimRuntimeVersion()).toBeUndefined();
    await writeFile(shimPath, '# agent-presence runtime-version: 1.2.3\nexec node /work/other/cli.js "$@"\n');
    expect(await readPresenceShimRuntimeVersion()).toBeUndefined();
    await writeFile(shimPath, '# agent-presence runtime-version: ../../outside\n');
    expect(await readPresenceShimRuntimeVersion()).toBeUndefined();
  });
});
