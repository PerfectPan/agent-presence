import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DSH_PLUGIN_FILE_NAME,
  DSH_PLUGIN_MARKER,
  installDshPlugin,
  uninstallDshPlugin,
  withDshAgentPresencePatch,
  withoutDshAgentPresencePatch
} from '../src/installers.js';

describe('installDshPlugin', () => {
  let homeDir: string;
  let pluginPath: string;
  let patchPath: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'agent-presence-dsh-'));
    pluginPath = join(homeDir, '.dsh', 'plugins', DSH_PLUGIN_FILE_NAME);
    patchPath = join(homeDir, '.dsh', 'cordis.patch.yml');
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('writes the managed plugin and creates the home-level patch', async () => {
    const result = await installDshPlugin({ pluginPath, patchPath });

    expect(result.status).toBe('installed');
    expect(result.patchUpdated).toBe(true);

    const written = await readFile(pluginPath, 'utf8');
    expect(written).toContain(DSH_PLUGIN_MARKER);
    expect(written).toContain('ctx.on("session/event"');
    expect(written).toContain('"agent/turn-stopping"');

    const patch = await readFile(patchPath, 'utf8');
    expect(patch).toContain('- insert:');
    expect(patch).toContain('id: agent-presence');
    expect(patch).toContain(`name: ${pluginPath}`);
  });

  it('is idempotent across repeated installs', async () => {
    await installDshPlugin({ pluginPath, patchPath });
    const firstPatch = await readFile(patchPath, 'utf8');

    await installDshPlugin({ pluginPath, patchPath });
    const secondPatch = await readFile(patchPath, 'utf8');

    expect(secondPatch).toBe(firstPatch);
  });

  it('preserves unrelated entries in an existing patch', async () => {
    await mkdir(join(homeDir, '.dsh'), { recursive: true });
    await writeFile(
      patchPath,
      '- id: some-plugin\n  config:\n    foo: bar\n',
      'utf8'
    );

    await installDshPlugin({ pluginPath, patchPath });

    const patch = await readFile(patchPath, 'utf8');
    expect(patch).toContain('some-plugin');
    expect(patch).toContain('foo: bar');
    expect(patch).toContain('id: agent-presence');
  });

  it('refuses to overwrite a non-managed file at the plugin path', async () => {
    await mkdir(join(homeDir, '.dsh', 'plugins'), { recursive: true });
    await writeFile(pluginPath, '// hand-rolled user plugin');

    await expect(installDshPlugin({ pluginPath, patchPath })).rejects.toThrow(/not managed/);
    const preserved = await readFile(pluginPath, 'utf8');
    expect(preserved).toBe('// hand-rolled user plugin');
  });
});

describe('uninstallDshPlugin', () => {
  let homeDir: string;
  let pluginPath: string;
  let patchPath: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'agent-presence-dsh-uninstall-'));
    pluginPath = join(homeDir, '.dsh', 'plugins', DSH_PLUGIN_FILE_NAME);
    patchPath = join(homeDir, '.dsh', 'cordis.patch.yml');
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('removes the managed plugin and strips the entry from the patch', async () => {
    await mkdir(join(homeDir, '.dsh'), { recursive: true });
    await writeFile(
      patchPath,
      '- id: some-plugin\n  config:\n    foo: bar\n',
      'utf8'
    );
    await installDshPlugin({ pluginPath, patchPath });

    const result = await uninstallDshPlugin({ pluginPath, patchPath });

    expect(result.status).toBe('removed');
    expect(result.patchUpdated).toBe(true);
    await expect(readFile(pluginPath, 'utf8')).rejects.toThrow();

    const patch = await readFile(patchPath, 'utf8');
    expect(patch).toContain('some-plugin');
    expect(patch).not.toContain('agent-presence');
  });

  it('removes the patch file entirely when only the managed entry remains', async () => {
    await installDshPlugin({ pluginPath, patchPath });

    await uninstallDshPlugin({ pluginPath, patchPath });

    await expect(readFile(patchPath, 'utf8')).rejects.toThrow();
  });

  it('does not delete a user-owned file at the plugin path', async () => {
    await mkdir(join(homeDir, '.dsh', 'plugins'), { recursive: true });
    await writeFile(pluginPath, '// user wrote this themselves');

    const result = await uninstallDshPlugin({ pluginPath, patchPath });
    expect(result.status).toBe('skipped');
    const preserved = await readFile(pluginPath, 'utf8');
    expect(preserved).toBe('// user wrote this themselves');
  });

  it('is a clean no-op when nothing is installed', async () => {
    const result = await uninstallDshPlugin({ pluginPath, patchPath });
    expect(result.status).toBe('skipped');
  });
});

describe('dsh patch merge', () => {
  it('appends to an empty input', () => {
    const result = withDshAgentPresencePatch('', '/x/agent-presence.mjs');
    expect(result).toContain('id: agent-presence');
    expect(result).toContain('name: /x/agent-presence.mjs');
  });

  it('strips the managed block cleanly', () => {
    const merged = withDshAgentPresencePatch('- id: foo\n', '/x/agent-presence.mjs');
    expect(withoutDshAgentPresencePatch(merged)).toBe('- id: foo\n');
  });
});
