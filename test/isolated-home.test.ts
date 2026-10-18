import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

import { SCAN_ENV } from '../src/cli/hook-context.js';
import { getConfigPath, getHomeDir, getLogPath, getPluginsDir, getStatePath } from '../src/config.js';
import { kitPlatform } from '../src/kit-platform.js';
import { collectWindowUsage, type BillableSource } from '../src/usage/index.js';
import { TEST_HOME_PREFIX } from './isolated-home.js';

const NOW = new Date(2026, 6, 14, 12, 0, 0, 0).getTime();

// Nothing in this file sets HOME, so it is whatever the shared setup file left for this test file.
function testRoot(): string {
  return dirname(homedir());
}

describe('test home isolation', () => {
  it('roots HOME, the presence home, the XDG directories and the agent homes in a per-file temporary directory', () => {
    const root = testRoot();
    expect(basename(root)).toMatch(new RegExp(`^${TEST_HOME_PREFIX}`));
    expect(dirname(root)).toBe(tmpdir());

    const presenceHome = join(homedir(), '.agent-presence');
    expect(getHomeDir()).toBe(presenceHome);
    expect([getConfigPath(), getStatePath(), getLogPath(), getPluginsDir()]).toEqual(
      ['config.json', 'state.json', 'agent-presence.log', 'plugins'].map((name) => join(presenceHome, name))
    );
    expect(Object.keys(process.env).filter((name) => /^AGENT_(?:PRESENCE|SIGNATURE)_/.test(name))).toEqual([]);

    // The kit platform keeps its harness ledger under XDG_STATE_HOME, or under its home when that is unset.
    expect(kitPlatform().home).toBe(homedir());
    expect(kitPlatform().env.XDG_STATE_HOME).toBe(join(root, 'xdg/state'));
    expect(process.env.XDG_CONFIG_HOME).toBe(join(root, 'xdg/config'));

    // Every agent home the usage scan reads is either unset (the kit falls back to HOME) or inside the root.
    const agentHomes = Object.values(SCAN_ENV).flatMap((name) => process.env[name] ?? []);
    expect(agentHomes).toEqual([join(root, 'xdg/data')]);
  });

  it('logs a failed usage scan under the temporary presence home', async () => {
    const boom: BillableSource = {
      id: 'boom',
      scanUsage: async () => {
        throw new Error('unreadable transcript store');
      }
    };

    await collectWindowUsage({ days: 1, now: NOW, sources: [boom] });

    const log = await readFile(join(testRoot(), 'home/.agent-presence/agent-presence.log'), 'utf8');
    expect(log).toContain('usage scan failed source=boom');
  });
});
