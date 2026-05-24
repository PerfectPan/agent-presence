import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETUP_SCRIPT_NAMES, DEFAULT_UNINSTALL_SCRIPT_NAMES, LINUX_WATCHER_SKIP_MESSAGE, platformSetupScriptNames, platformUninstallScriptNames, runSetupScripts, runUninstallScripts } from '../src/setup.js';

describe('runSetupScripts', () => {
  it('runs every local installer script in setup order', async () => {
    const runner = vi.fn().mockResolvedValue(undefined);

    const results = await runSetupScripts({
      runner,
      resolveScriptPath: (scriptName) => `/dist/scripts/${scriptName}`,
      scriptNames: DEFAULT_SETUP_SCRIPT_NAMES
    });

    expect(DEFAULT_SETUP_SCRIPT_NAMES).toEqual([
      'install-codex-hook.js',
      'install-claude-hook.js',
      'install-opencode-plugin.js',
      'install-gemini-hook.js',
      'install-pi-extension.js',
      'install-shutdown-watcher.js'
    ]);
    expect(runner).toHaveBeenCalledTimes(6);
    expect(runner).toHaveBeenNthCalledWith(1, '/dist/scripts/install-codex-hook.js');
    expect(runner).toHaveBeenNthCalledWith(5, '/dist/scripts/install-pi-extension.js');
    expect(runner).toHaveBeenNthCalledWith(6, '/dist/scripts/install-shutdown-watcher.js');
    expect(results).toEqual([
      { scriptName: 'install-codex-hook.js', scriptPath: '/dist/scripts/install-codex-hook.js' },
      { scriptName: 'install-claude-hook.js', scriptPath: '/dist/scripts/install-claude-hook.js' },
      { scriptName: 'install-opencode-plugin.js', scriptPath: '/dist/scripts/install-opencode-plugin.js' },
      { scriptName: 'install-gemini-hook.js', scriptPath: '/dist/scripts/install-gemini-hook.js' },
      { scriptName: 'install-pi-extension.js', scriptPath: '/dist/scripts/install-pi-extension.js' },
      { scriptName: 'install-shutdown-watcher.js', scriptPath: '/dist/scripts/install-shutdown-watcher.js' }
    ]);
  });

  it('runs every local uninstaller script in uninstall order', async () => {
    const runner = vi.fn().mockResolvedValue(undefined);

    const results = await runUninstallScripts({
      runner,
      resolveScriptPath: (scriptName) => `/dist/scripts/${scriptName}`,
      scriptNames: DEFAULT_UNINSTALL_SCRIPT_NAMES
    });

    expect(DEFAULT_UNINSTALL_SCRIPT_NAMES).toEqual([
      'uninstall-codex-hook.js',
      'uninstall-claude-hook.js',
      'uninstall-opencode-plugin.js',
      'uninstall-gemini-hook.js',
      'uninstall-pi-extension.js',
      'uninstall-shutdown-watcher.js'
    ]);
    expect(runner).toHaveBeenCalledTimes(6);
    expect(runner).toHaveBeenNthCalledWith(1, '/dist/scripts/uninstall-codex-hook.js');
    expect(runner).toHaveBeenNthCalledWith(5, '/dist/scripts/uninstall-pi-extension.js');
    expect(runner).toHaveBeenNthCalledWith(6, '/dist/scripts/uninstall-shutdown-watcher.js');
    expect(results).toEqual([
      { scriptName: 'uninstall-codex-hook.js', scriptPath: '/dist/scripts/uninstall-codex-hook.js' },
      { scriptName: 'uninstall-claude-hook.js', scriptPath: '/dist/scripts/uninstall-claude-hook.js' },
      { scriptName: 'uninstall-opencode-plugin.js', scriptPath: '/dist/scripts/uninstall-opencode-plugin.js' },
      { scriptName: 'uninstall-gemini-hook.js', scriptPath: '/dist/scripts/uninstall-gemini-hook.js' },
      { scriptName: 'uninstall-pi-extension.js', scriptPath: '/dist/scripts/uninstall-pi-extension.js' },
      { scriptName: 'uninstall-shutdown-watcher.js', scriptPath: '/dist/scripts/uninstall-shutdown-watcher.js' }
    ]);
  });
});

describe('platform-aware script filtering', () => {
  it('includes watcher on macOS', () => {
    const setupNames = platformSetupScriptNames('darwin');
    expect(setupNames).toContain('install-shutdown-watcher.js');
    expect(setupNames).toEqual([
      'install-codex-hook.js',
      'install-claude-hook.js',
      'install-opencode-plugin.js',
      'install-gemini-hook.js',
      'install-pi-extension.js',
      'install-shutdown-watcher.js'
    ]);

    const uninstallNames = platformUninstallScriptNames('darwin');
    expect(uninstallNames).toContain('uninstall-shutdown-watcher.js');
    expect(uninstallNames).toEqual([
      'uninstall-codex-hook.js',
      'uninstall-claude-hook.js',
      'uninstall-opencode-plugin.js',
      'uninstall-gemini-hook.js',
      'uninstall-pi-extension.js',
      'uninstall-shutdown-watcher.js'
    ]);
  });

  it('excludes watcher on Linux but keeps pi extension', () => {
    const setupNames = platformSetupScriptNames('linux');
    expect(setupNames).not.toContain('install-shutdown-watcher.js');
    expect(setupNames).toContain('install-pi-extension.js');
    expect(setupNames).toEqual([
      'install-codex-hook.js',
      'install-claude-hook.js',
      'install-opencode-plugin.js',
      'install-gemini-hook.js',
      'install-pi-extension.js'
    ]);

    const uninstallNames = platformUninstallScriptNames('linux');
    expect(uninstallNames).not.toContain('uninstall-shutdown-watcher.js');
    expect(uninstallNames).toContain('uninstall-pi-extension.js');
    expect(uninstallNames).toEqual([
      'uninstall-codex-hook.js',
      'uninstall-claude-hook.js',
      'uninstall-opencode-plugin.js',
      'uninstall-gemini-hook.js',
      'uninstall-pi-extension.js'
    ]);
  });

  it('skips watcher when running setup on Linux (via runSetupScripts)', async () => {
    const runner = vi.fn().mockResolvedValue(undefined);

    const results = await runSetupScripts({
      runner,
      resolveScriptPath: (name) => `/dist/scripts/${name}`,
      scriptNames: platformSetupScriptNames('linux')
    });

    expect(runner).toHaveBeenCalledTimes(5);
    expect(results.map((r) => r.scriptName)).not.toContain('install-shutdown-watcher.js');
    expect(results.map((r) => r.scriptName)).toContain('install-pi-extension.js');
  });

  it('provides a skip message for Linux watcher', () => {
    expect(LINUX_WATCHER_SKIP_MESSAGE).toContain('skipping power watcher');
    expect(LINUX_WATCHER_SKIP_MESSAGE).toContain('TTL pruning');
  });
});
