import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { DSH_PLUGIN_FILE_NAME, installDshPlugin } from '../src/installers.js';

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
