import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
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
    vi.stubEnv('AGENT_PRESENCE_HOME', join(homeDir, "presence's $runtime"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
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

  it.each(['package', 'npx', 'absolute'])('uses the stable shim in %s mode', async (mode) => {
    vi.stubEnv('AGENT_PRESENCE_HOOK_COMMAND', mode);
    vi.stubEnv('AGENT_PRESENCE_CLI_PATH', '/work/checkout/dist/src/cli.js');

    await installDshPlugin({ pluginPath, patchPath });

    const written = await readFile(pluginPath, 'utf8');
    const shimPath = join(homeDir, "presence's $runtime", 'bin', 'agent-presence');
    expect(written).toContain(`const CLI_COMMAND = ${JSON.stringify([shimPath])}`);
    expect(written).toContain('"hook", "--source", SOURCE, "--event", event, "--silent"');
    expect(written).not.toContain('npx');
    expect(written).not.toContain('/work/checkout/dist/src/cli.js');
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
    await writeFile(patchPath, '- id: some-plugin\n  config:\n    foo: bar\n', 'utf8');

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

  it('reopens a session on the next prompt after an idle Stop', async () => {
    await installDshPlugin({ pluginPath, patchPath });
    // The plugin calls the presence shim; record each event it would deliver.
    const shimPath = join(homeDir, "presence's $runtime", 'bin', 'agent-presence');
    const logPath = join(homeDir, 'events.log');
    await mkdir(join(homeDir, "presence's $runtime", 'bin'), { recursive: true });
    await writeFile(shimPath, `#!/bin/sh\nline=$(cat)\nprintf '%s\\n' "$line" >> '${logPath}'\n`);
    await chmod(shimPath, 0o755);

    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const plugin = (await import(pathToFileURL(pluginPath).href)) as { apply(ctx: unknown): void };
    plugin.apply({ on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler) });

    const agent = { session: { header: { id: 'dsh-1', cwd: homeDir } } };
    const status = handlers.get('agent/status')!;
    status({ status: 'running', agent });
    status({ status: 'idle', agent });
    status({ status: 'running', agent });

    const readEvents = async (): Promise<string[]> => {
      const text = await readFile(logPath, 'utf8').catch(() => '');
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { event: string }).event);
    };
    await vi.waitFor(async () => expect(await readEvents()).toHaveLength(3), { timeout: 5000 });

    const events = await readEvents();
    expect(events.filter((event) => event === 'Stop')).toHaveLength(1);
    expect(events.filter((event) => event === 'UserPromptSubmit')).toHaveLength(2);
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
    await writeFile(patchPath, '- id: some-plugin\n  config:\n    foo: bar\n', 'utf8');
    await installDshPlugin({ pluginPath, patchPath });

    const result = await uninstallDshPlugin({ pluginPath, patchPath });

    expect(result.status).toBe('removed');
    expect(result.patchUpdated).toBe(true);
    await expect(readFile(pluginPath, 'utf8')).rejects.toThrow(/ENOENT/);

    const patch = await readFile(patchPath, 'utf8');
    expect(patch).toContain('some-plugin');
    expect(patch).not.toContain('agent-presence');
  });

  it('removes the patch file entirely when only the managed entry remains', async () => {
    await installDshPlugin({ pluginPath, patchPath });

    await uninstallDshPlugin({ pluginPath, patchPath });

    await expect(readFile(patchPath, 'utf8')).rejects.toThrow(/ENOENT/);
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
