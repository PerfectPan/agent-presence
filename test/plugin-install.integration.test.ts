import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../src/config.js';
import { installPluginPackage } from '../src/plugin-install.js';
import {
  loadSourcePluginForValidation,
  resetSourcePluginCacheForTests,
  resolveHookContextForSource
} from '../src/sources.js';

let workDir: string;
let pluginsDir: string;
let configPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'agent-presence-install-'));
  pluginsDir = join(workDir, 'plugins');
  configPath = join(workDir, 'config.json');
  writeFileSync(configPath, '{}', { mode: 0o600 });
  process.env.AGENT_PRESENCE_PLUGINS_DIR = pluginsDir;
  process.env.AGENT_PRESENCE_CONFIG_FILE = configPath;
  process.env.AGENT_PRESENCE_LOG_FILE = join(workDir, 'log.txt');
  resetSourcePluginCacheForTests();
});

afterEach(async () => {
  delete process.env.AGENT_PRESENCE_PLUGINS_DIR;
  delete process.env.AGENT_PRESENCE_CONFIG_FILE;
  delete process.env.AGENT_PRESENCE_LOG_FILE;
  resetSourcePluginCacheForTests();
  await rm(workDir, { recursive: true, force: true });
});

/**
 * A fake npm that materializes a package under node_modules the way a real
 * `npm install <name>` would, so we exercise install/resolve without network.
 */
function fakeNpm(pkgName: string, version: string, body: string) {
  return async (args: string[], cwd: string): Promise<void> => {
    if (args[0] !== 'install') {
      return;
    }
    const pkgDir = join(cwd, 'node_modules', pkgName);
    await mkdir(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: pkgName, version, type: 'module', main: 'index.mjs' })
    );
    writeFileSync(join(pkgDir, 'index.mjs'), body);
  };
}

describe('loadSourcePluginForValidation', () => {
  it('accepts a valid source plugin and returns its id', async () => {
    const runner = fakeNpm(
      'agent-presence-myagent',
      '1.0.0',
      `export default { id: 'myagent', resolveHookContext(){ return {}; } };`
    );
    await installPluginPackage('agent-presence-myagent', { pluginsDir, runner });
    const result = await loadSourcePluginForValidation('agent-presence-myagent');
    expect(result).toEqual({ ok: true, id: 'myagent' });
  });

  it('rejects a package whose default export is not a source plugin', async () => {
    const runner = fakeNpm('agent-presence-bad', '1.0.0', `export default { nope: true };`);
    await installPluginPackage('agent-presence-bad', { pluginsDir, runner });
    const result = await loadSourcePluginForValidation('agent-presence-bad');
    expect(result.ok).toBe(false);
  });

  it('rejects a package that cannot be resolved', async () => {
    const result = await loadSourcePluginForValidation('agent-presence-missing');
    expect(result.ok).toBe(false);
  });
});

describe('bare specifier resolution through the plugins dir', () => {
  it('resolves and runs an installed package by name from config', async () => {
    const runner = fakeNpm(
      'agent-presence-myagent',
      '1.0.0',
      `export default { id: 'myagent', resolveHookContext(p){ return { sessionId: p.session_id, project: p.cwd }; } };`
    );
    await installPluginPackage('agent-presence-myagent', { pluginsDir, runner });

    const config: AppConfig = {
      plugins: { sources: { myagent: { handler: 'agent-presence-myagent' } } }
    };
    const context = await resolveHookContextForSource('myagent', { session_id: 'pkg-1', cwd: '/w' }, config);
    expect(context).toEqual({ sessionId: 'pkg-1', project: '/w' });
  });

  it('fails open when the configured package is not installed', async () => {
    const config: AppConfig = {
      plugins: { sources: { myagent: { handler: 'agent-presence-not-installed' } } }
    };
    const context = await resolveHookContextForSource('myagent', { session_id: 'x' }, config);
    expect(context).toEqual({});
  });
});
