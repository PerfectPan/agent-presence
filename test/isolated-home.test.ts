import { existsSync, globSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { SCAN_ENV } from '../src/cli/hook-context.js';
import {
  DEFAULT_MAGIC_BUILDER_BASE_URL,
  getConfigPath,
  getHomeDir,
  getLogPath,
  getPluginsDir,
  getStatePath,
  magicBuilderBaseUrl
} from '../src/config.js';
import { resolveDshPluginPaths } from '../src/installers.js';
import { kitPlatform } from '../src/kit-platform.js';
import { envTreatment, isolateTestHome, TEST_HOME_PREFIX } from './isolated-home.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// How src names an environment variable: a property of `process.env` or of an env parameter, or a quoted UPPER_SNAKE
// name it hands to a helper (hook `envKeys`, `SCAN_ENV`, the setup's list of ignored overrides). This check is lexical.
// It scans src only: names the kit reads from the environment src hands it (terminal-pane and session variables in the
// kit's hook dialects) are covered by the cleared prefixes, not by this scan. After a kit upgrade, check the kit's new
// environment reads against the lists in `isolated-home.ts`.
const ENV_NAME_PATTERNS = [
  /\benv\.([A-Z][A-Z0-9_]*)/g,
  /\benv\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
  /['"]([A-Z][A-Z0-9]*_[A-Z0-9_]+)['"]/g
];

function envNamesReadBySrc(): string[] {
  const names = new Set<string>();
  for (const file of globSync('src/**/*.ts', { cwd: repoRoot })) {
    const source = readFileSync(join(repoRoot, file), 'utf8');
    for (const pattern of ENV_NAME_PATTERNS) {
      for (const [, name] of source.matchAll(pattern)) {
        names.add(name!);
      }
    }
  }
  return [...names].sort();
}

// Nothing in this file sets HOME outside `isolateTestHome`, so it is whatever the shared setup file left for this file.
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
    expect(resolveDshPluginPaths()).toEqual({
      pluginPath: join(homedir(), '.dsh/plugins/agent-presence.mjs'),
      patchPath: join(homedir(), '.dsh/cordis.patch.yml')
    });
    expect(Object.keys(process.env).filter((name) => envTreatment(name) === 'cleared')).toEqual([]);

    // The kit platform keeps its harness ledger under XDG_STATE_HOME, or under its home when that is unset.
    expect(kitPlatform().home).toBe(homedir());
    expect(kitPlatform().env.XDG_STATE_HOME).toBe(join(root, 'xdg/state'));
    expect(process.env.XDG_CONFIG_HOME).toBe(join(root, 'xdg/config'));

    // Every agent home the usage scan reads is either unset (the kit falls back to HOME) or inside the root.
    const agentHomes = Object.values(SCAN_ENV).flatMap((name) => process.env[name] ?? []);
    expect(agentHomes).toEqual([join(root, 'xdg/data')]);
  });

  it('isolates, clears or deliberately keeps every environment variable src reads', () => {
    const names = envNamesReadBySrc();
    // Direct reads and helper-listed names are both found, so the scan below is not vacuous.
    expect(names).toEqual(
      expect.arrayContaining(['DSH_AGENT_PRESENCE_PLUGIN_FILE', 'MAGIC_BASE_URL', 'CLAUDE_SESSION_ID'])
    );
    expect(names.filter((name) => envTreatment(name) === undefined)).toEqual([]);
  });
});

describe('isolateTestHome', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('clears the caller overrides while active, then restores them, HOME and the environment', () => {
    const callerPlugin = '/caller/.dsh/plugins/agent-presence.mjs';
    vi.stubEnv('DSH_AGENT_PRESENCE_PLUGIN_FILE', callerPlugin);
    vi.stubEnv('MAGIC_BASE_URL', 'http://127.0.0.1:9/caller');
    vi.stubEnv('PRESENCE_RACE_RUNS', '7');
    const previousHome = homedir();

    const restore = isolateTestHome();
    const root = testRoot();
    // Restore even when an assertion fails, so the root is removed and HOME does not stay redirected.
    try {
      expect(process.env.DSH_AGENT_PRESENCE_PLUGIN_FILE).toBeUndefined();
      expect(resolveDshPluginPaths().pluginPath).toBe(join(root, 'home/.dsh/plugins/agent-presence.mjs'));
      expect(magicBuilderBaseUrl({})).toBe(DEFAULT_MAGIC_BUILDER_BASE_URL);
      expect(process.env.PRESENCE_RACE_RUNS).toBe('7');
      expect(root).not.toBe(dirname(previousHome));
      process.env.AGENT_PRESENCE_HOME = join(root, 'set-by-a-test');
    } finally {
      restore();
    }

    expect(process.env.DSH_AGENT_PRESENCE_PLUGIN_FILE).toBe(callerPlugin);
    expect(process.env.MAGIC_BASE_URL).toBe('http://127.0.0.1:9/caller');
    expect(process.env.AGENT_PRESENCE_HOME).toBeUndefined();
    expect(homedir()).toBe(previousHome);
    expect(existsSync(root)).toBe(false);
  });
});
