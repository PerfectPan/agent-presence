import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const dependencies = vi.hoisted(() => ({
  existsSync: vi.fn<typeof import('node:fs').existsSync>(),
  writeShim: vi.fn<typeof import('../src/harness/shim.js').writePresenceShim>(),
  installDsh: vi.fn<typeof import('../src/installers.js').installDshPlugin>(),
  chmod: vi.fn<typeof import('node:fs/promises').chmod>(),
  mkdir: vi.fn<typeof import('node:fs/promises').mkdir>(),
  rm: vi.fn<typeof import('node:fs/promises').rm>(),
  writeFile: vi.fn<typeof import('node:fs/promises').writeFile>(),
  launchctl: vi.fn<(command: string, args: string[], callback: (error: null) => void) => void>()
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: dependencies.existsSync
}));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  chmod: dependencies.chmod,
  mkdir: dependencies.mkdir,
  rm: dependencies.rm,
  writeFile: dependencies.writeFile
}));
vi.mock('node:child_process', () => ({ execFile: dependencies.launchctl }));
vi.mock('../src/harness/shim.js', () => ({ writePresenceShim: dependencies.writeShim }));
vi.mock('../src/platform.js', () => ({
  assertMacOS: vi.fn<typeof import('../src/platform.js').assertMacOS>(),
  assertSupportedPlatform: vi.fn<typeof import('../src/platform.js').assertSupportedPlatform>()
}));
vi.mock('../src/installers.js', () => ({
  installDshPlugin: dependencies.installDsh,
  resolveDshPluginPaths: () => ({ pluginPath: '/fake-home/dsh/plugin.mjs', patchPath: '/fake-home/dsh/patch.yml' })
}));
vi.mock('../src/power-watcher.js', () => ({
  buildPowerWatcherScript: () => '#!/bin/sh\n',
  buildPowerEventWatcherSwift: () => 'import Foundation\n',
  buildPowerWatcherPlist: () => '<plist/>\n'
}));

let previousExitCode: typeof process.exitCode;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.stubEnv('AGENT_PRESENCE_HOME', '/fake-home/presence');
  dependencies.writeShim.mockResolvedValue('/fake-home/presence/bin/agent-presence');
  dependencies.installDsh.mockResolvedValue({
    status: 'installed',
    pluginPath: '/fake-home/dsh/plugin.mjs',
    patchPath: '/fake-home/dsh/patch.yml',
    patchUpdated: true
  });
  dependencies.chmod.mockResolvedValue(undefined);
  dependencies.mkdir.mockResolvedValue(undefined);
  dependencies.rm.mockResolvedValue(undefined);
  dependencies.writeFile.mockResolvedValue(undefined);
  dependencies.launchctl.mockImplementation((_command, _args, callback) => callback(null));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function runScript(script: 'dsh' | 'watcher'): Promise<void> {
  if (script === 'dsh') {
    await import('../scripts/install-dsh-plugin.js');
    await vi.waitFor(() => expect(console.log).toHaveBeenCalledWith('updated dsh patch: /fake-home/dsh/patch.yml'));
  } else {
    await import('../scripts/install-shutdown-watcher.js');
    await vi.waitFor(() =>
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('installed power event watcher:'))
    );
  }
  expect(console.error).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
}

describe.each(['dsh', 'watcher'] as const)('standalone %s installer', (script) => {
  it('creates an absolute checkout shim before writing installer targets when none exists', async () => {
    dependencies.existsSync.mockReturnValue(false);

    await runScript(script);

    expect(dependencies.existsSync).toHaveBeenCalledWith('/fake-home/presence/bin/agent-presence');
    expect(dependencies.writeShim).toHaveBeenCalledExactlyOnceWith(undefined, { mode: 'absolute' });
    const targetWrite = script === 'dsh' ? dependencies.installDsh : dependencies.writeFile;
    expect(dependencies.writeShim.mock.invocationCallOrder[0]).toBeLessThan(targetWrite.mock.invocationCallOrder[0]!);
  });

  it('preserves an existing shim while installing its targets', async () => {
    dependencies.existsSync.mockReturnValue(true);

    await runScript(script);

    expect(dependencies.writeShim).not.toHaveBeenCalled();
    if (script === 'dsh') {
      expect(dependencies.installDsh).toHaveBeenCalledOnce();
    } else {
      expect(dependencies.writeFile).toHaveBeenCalledTimes(3);
    }
  });
});
