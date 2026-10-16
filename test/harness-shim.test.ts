import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import * as z from 'zod/mini';
import { createPresenceBundle } from '../src/harness/bundle.js';
import { removePresenceShim, writePresenceShim } from '../src/harness/shim.js';

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
  it('writes an executable default-home shim with the pinned registry command and argument forwarding', async () => {
    const pkg = z.parse(
      z.object({ version: z.string() }),
      JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    );

    expect(await writePresenceShim()).toBe(shimPath);
    expect(await readFile(shimPath, 'utf8')).toBe(
      `#!/bin/sh\nexec npx --yes --registry=https://registry.npmjs.org @rivus/agent-presence@${pkg.version} "$@"\n`
    );
    expect((await stat(shimPath)).mode & 0o777).toBe(0o755);
    expect(await readdir(dirname(shimPath))).toEqual(['agent-presence']);
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
    const expected = `#!/bin/sh\nexec '/work/node bin/node' '/work/presence'\\''s checkout/$runtime/dist/src/cli.js' "$@"\n`;
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
    expect(await readdir(dirname(shimPath))).toEqual(['agent-presence']);
  });

  it('preserves the existing shim and removes the temporary file when writing fails', async () => {
    await mkdir(dirname(shimPath), { recursive: true });
    const previous = '#!/bin/sh\nexec previous "$@"\n';
    await writeFile(shimPath, previous, { mode: 0o600 });
    shimIo.failWrite = true;

    await expect(writePresenceShim()).rejects.toThrow('shim write blocked by the test');
    expect(await readFile(shimPath, 'utf8')).toBe(previous);
    expect((await stat(shimPath)).mode & 0o777).toBe(0o600);
    expect(await readdir(dirname(shimPath))).toEqual(['agent-presence']);
  });

  it('removes only the shim and accepts an already absent shim', async () => {
    await writePresenceShim();
    const unrelated = join(dirname(shimPath), 'keep');
    await writeFile(unrelated, 'unrelated');

    await removePresenceShim();
    await removePresenceShim();

    await expect(readFile(shimPath, 'utf8')).rejects.toThrow(/ENOENT/);
    expect(await readFile(unrelated, 'utf8')).toBe('unrelated');
    expect(await readdir(dirname(shimPath))).toEqual(['keep']);
  });
});
