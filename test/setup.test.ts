import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETUP_SCRIPT_NAMES, DEFAULT_UNINSTALL_SCRIPT_NAMES, runSetupScripts, runUninstallScripts } from '../src/setup.js';

describe('runSetupScripts', () => {
  it('runs every local installer script in setup order', async () => {
    const runner = vi.fn().mockResolvedValue(undefined);

    const results = await runSetupScripts({
      runner,
      resolveScriptPath: (scriptName) => `/dist/scripts/${scriptName}`
    });

    expect(DEFAULT_SETUP_SCRIPT_NAMES).toEqual([
      'install-codex-hook.js',
      'install-claude-hook.js',
      'install-opencode-plugin.js',
      'install-gemini-hook.js',
      'install-shutdown-watcher.js'
    ]);
    expect(runner).toHaveBeenCalledTimes(5);
    expect(runner).toHaveBeenNthCalledWith(1, '/dist/scripts/install-codex-hook.js');
    expect(runner).toHaveBeenNthCalledWith(5, '/dist/scripts/install-shutdown-watcher.js');
    expect(results).toEqual([
      { scriptName: 'install-codex-hook.js', scriptPath: '/dist/scripts/install-codex-hook.js' },
      { scriptName: 'install-claude-hook.js', scriptPath: '/dist/scripts/install-claude-hook.js' },
      { scriptName: 'install-opencode-plugin.js', scriptPath: '/dist/scripts/install-opencode-plugin.js' },
      { scriptName: 'install-gemini-hook.js', scriptPath: '/dist/scripts/install-gemini-hook.js' },
      { scriptName: 'install-shutdown-watcher.js', scriptPath: '/dist/scripts/install-shutdown-watcher.js' }
    ]);
  });

  it('runs every local uninstaller script in uninstall order', async () => {
    const runner = vi.fn().mockResolvedValue(undefined);

    const results = await runUninstallScripts({
      runner,
      resolveScriptPath: (scriptName) => `/dist/scripts/${scriptName}`
    });

    expect(DEFAULT_UNINSTALL_SCRIPT_NAMES).toEqual([
      'uninstall-codex-hook.js',
      'uninstall-claude-hook.js',
      'uninstall-opencode-plugin.js',
      'uninstall-gemini-hook.js',
      'uninstall-shutdown-watcher.js'
    ]);
    expect(runner).toHaveBeenCalledTimes(5);
    expect(runner).toHaveBeenNthCalledWith(1, '/dist/scripts/uninstall-codex-hook.js');
    expect(runner).toHaveBeenNthCalledWith(5, '/dist/scripts/uninstall-shutdown-watcher.js');
    expect(results).toEqual([
      { scriptName: 'uninstall-codex-hook.js', scriptPath: '/dist/scripts/uninstall-codex-hook.js' },
      { scriptName: 'uninstall-claude-hook.js', scriptPath: '/dist/scripts/uninstall-claude-hook.js' },
      { scriptName: 'uninstall-opencode-plugin.js', scriptPath: '/dist/scripts/uninstall-opencode-plugin.js' },
      { scriptName: 'uninstall-gemini-hook.js', scriptPath: '/dist/scripts/uninstall-gemini-hook.js' },
      { scriptName: 'uninstall-shutdown-watcher.js', scriptPath: '/dist/scripts/uninstall-shutdown-watcher.js' }
    ]);
  });
});
