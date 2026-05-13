import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETUP_SCRIPT_NAMES, runSetupScripts } from '../src/setup.js';

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
      'install-shutdown-watcher.js'
    ]);
    expect(runner).toHaveBeenCalledTimes(4);
    expect(runner).toHaveBeenNthCalledWith(1, '/dist/scripts/install-codex-hook.js');
    expect(runner).toHaveBeenNthCalledWith(4, '/dist/scripts/install-shutdown-watcher.js');
    expect(results).toEqual([
      { scriptName: 'install-codex-hook.js', scriptPath: '/dist/scripts/install-codex-hook.js' },
      { scriptName: 'install-claude-hook.js', scriptPath: '/dist/scripts/install-claude-hook.js' },
      { scriptName: 'install-opencode-plugin.js', scriptPath: '/dist/scripts/install-opencode-plugin.js' },
      { scriptName: 'install-shutdown-watcher.js', scriptPath: '/dist/scripts/install-shutdown-watcher.js' }
    ]);
  });
});
