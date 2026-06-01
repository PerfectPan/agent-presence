import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PI_EXTENSION_FILE_NAME,
  PI_EXTENSION_MARKER,
  installPiExtension,
  uninstallPiExtension
} from '../src/installers.js';

describe('installPiExtension', () => {
  let homeDir: string;
  let extensionPath: string;
  let settingsPath: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'agent-presence-pi-'));
    extensionPath = join(homeDir, '.pi', 'agent', 'extensions', PI_EXTENSION_FILE_NAME);
    settingsPath = join(homeDir, '.pi', 'agent', 'settings.json');
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('writes the managed extension and creates a settings file when neither exists', async () => {
    const result = await installPiExtension({ extensionPath, settingsPath });

    expect(result.status).toBe('installed');
    expect(result.settingsUpdated).toBe(true);

    const written = await readFile(extensionPath, 'utf8');
    expect(written).toContain(PI_EXTENSION_MARKER);
    expect(written).toContain('pi.on("before_agent_start"');

    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as { extensions?: string[] };
    // Auto-discovery covers the file; settings should not list it.
    expect(settings.extensions ?? []).not.toContain(extensionPath);
  });

  it('is idempotent across repeated installs', async () => {
    await installPiExtension({ extensionPath, settingsPath });
    const firstContent = await readFile(extensionPath, 'utf8');

    await installPiExtension({ extensionPath, settingsPath });
    const secondContent = await readFile(extensionPath, 'utf8');

    expect(secondContent).toBe(firstContent);
  });

  it('preserves user-defined extensions in settings.json', async () => {
    const userExtension = join(homeDir, '.pi', 'agent', 'extensions', 'my-tool.ts');
    await writeFile(settingsPath.replace(/[^/]+$/, ''), '', { flag: 'a' }).catch(() => {});
    await rm(settingsPath, { force: true });
    // Seed settings with an unrelated extension.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(homeDir, '.pi', 'agent'), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ extensions: [userExtension], theme: 'dark' }, null, 2));

    await installPiExtension({ extensionPath, settingsPath });

    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      extensions?: string[];
      theme?: string;
    };
    expect(settings.theme).toBe('dark');
    expect(settings.extensions).toEqual([userExtension]);
  });

  it('refuses to overwrite a non-managed file at the extension path', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(homeDir, '.pi', 'agent', 'extensions'), { recursive: true });
    await writeFile(extensionPath, '// hand-rolled user extension');

    await expect(installPiExtension({ extensionPath, settingsPath })).rejects.toThrow(/not managed/);
    const preserved = await readFile(extensionPath, 'utf8');
    expect(preserved).toBe('// hand-rolled user extension');
  });
});

describe('uninstallPiExtension', () => {
  let homeDir: string;
  let extensionPath: string;
  let settingsPath: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'agent-presence-pi-uninstall-'));
    extensionPath = join(homeDir, '.pi', 'agent', 'extensions', PI_EXTENSION_FILE_NAME);
    settingsPath = join(homeDir, '.pi', 'agent', 'settings.json');
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('removes the managed extension and strips the entry from settings', async () => {
    await installPiExtension({ extensionPath, settingsPath });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(homeDir, '.pi', 'agent'), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({ extensions: [extensionPath, '/Users/example/keep.ts'] }, null, 2)
    );

    const result = await uninstallPiExtension({ extensionPath, settingsPath });

    expect(result.status).toBe('removed');
    expect(result.settingsUpdated).toBe(true);
    await expect(readFile(extensionPath, 'utf8')).rejects.toThrow();

    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as { extensions?: string[] };
    expect(settings.extensions).toEqual(['/Users/example/keep.ts']);
  });

  it('does not delete a user-owned file at the extension path', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(homeDir, '.pi', 'agent', 'extensions'), { recursive: true });
    await writeFile(extensionPath, '// user wrote this themselves');

    const result = await uninstallPiExtension({ extensionPath, settingsPath });
    expect(result.status).toBe('skipped');
    const preserved = await readFile(extensionPath, 'utf8');
    expect(preserved).toBe('// user wrote this themselves');
  });

  it('is a clean no-op when nothing is installed', async () => {
    const result = await uninstallPiExtension({ extensionPath, settingsPath });
    expect(result.status).toBe('skipped');
    expect(result.settingsUpdated).toBe(true);
  });
});
