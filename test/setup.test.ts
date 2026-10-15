import { describe, expect, it, vi } from 'vite-plus/test';
import {
  DEFAULT_SETUP_SCRIPT_NAMES,
  DEFAULT_UNINSTALL_SCRIPT_NAMES,
  LINUX_WATCHER_SKIP_MESSAGE,
  platformSetupScriptNames,
  platformUninstallScriptNames,
  runSetupScripts,
  runUninstallScripts
} from '../src/setup.js';

describe('runSetupScripts', () => {
  it('runs only the local watcher installer', async () => {
    const runner = vi.fn<(scriptPath: string) => Promise<void>>().mockResolvedValue(undefined);

    const results = await runSetupScripts({
      runner,
      resolveScriptPath: (scriptName) => `/dist/scripts/${scriptName}`,
      scriptNames: DEFAULT_SETUP_SCRIPT_NAMES
    });

    expect(DEFAULT_SETUP_SCRIPT_NAMES).toEqual(['install-shutdown-watcher.js']);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenNthCalledWith(1, '/dist/scripts/install-shutdown-watcher.js');
    expect(results).toEqual([
      { scriptName: 'install-shutdown-watcher.js', scriptPath: '/dist/scripts/install-shutdown-watcher.js' }
    ]);
  });

  it('runs only the local dsh and watcher uninstallers in order', async () => {
    const runner = vi.fn<(scriptPath: string) => Promise<void>>().mockResolvedValue(undefined);

    const results = await runUninstallScripts({
      runner,
      resolveScriptPath: (scriptName) => `/dist/scripts/${scriptName}`,
      scriptNames: DEFAULT_UNINSTALL_SCRIPT_NAMES
    });

    expect(DEFAULT_UNINSTALL_SCRIPT_NAMES).toEqual(['uninstall-dsh-plugin.js', 'uninstall-shutdown-watcher.js']);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner).toHaveBeenNthCalledWith(1, '/dist/scripts/uninstall-dsh-plugin.js');
    expect(runner).toHaveBeenNthCalledWith(2, '/dist/scripts/uninstall-shutdown-watcher.js');
    expect(results).toEqual([
      { scriptName: 'uninstall-dsh-plugin.js', scriptPath: '/dist/scripts/uninstall-dsh-plugin.js' },
      { scriptName: 'uninstall-shutdown-watcher.js', scriptPath: '/dist/scripts/uninstall-shutdown-watcher.js' }
    ]);
  });
});

describe('platform-aware script filtering', () => {
  it('includes watcher on macOS', () => {
    const setupNames = platformSetupScriptNames('darwin');
    expect(setupNames).toContain('install-shutdown-watcher.js');
    expect(setupNames).toEqual(['install-shutdown-watcher.js']);

    const uninstallNames = platformUninstallScriptNames('darwin');
    expect(uninstallNames).toContain('uninstall-shutdown-watcher.js');
    expect(uninstallNames).toEqual(['uninstall-dsh-plugin.js', 'uninstall-shutdown-watcher.js']);
  });

  it('has no setup script on Linux and keeps only dsh for uninstall', () => {
    const setupNames = platformSetupScriptNames('linux');
    expect(setupNames).not.toContain('install-shutdown-watcher.js');
    expect(setupNames).toEqual([]);

    const uninstallNames = platformUninstallScriptNames('linux');
    expect(uninstallNames).not.toContain('uninstall-shutdown-watcher.js');
    expect(uninstallNames).toEqual(['uninstall-dsh-plugin.js']);
  });

  it('skips watcher when running setup on Linux (via runSetupScripts)', async () => {
    const runner = vi.fn<(scriptPath: string) => Promise<void>>().mockResolvedValue(undefined);

    const results = await runSetupScripts({
      runner,
      resolveScriptPath: (name) => `/dist/scripts/${name}`,
      scriptNames: platformSetupScriptNames('linux')
    });

    expect(runner).not.toHaveBeenCalled();
    expect(results.map((r) => r.scriptName)).not.toContain('install-shutdown-watcher.js');
    expect(results).toEqual([]);
  });

  it('provides a skip message for Linux watcher', () => {
    expect(LINUX_WATCHER_SKIP_MESSAGE).toContain('skipping power watcher');
    expect(LINUX_WATCHER_SKIP_MESSAGE).toContain('TTL pruning');
  });
});
