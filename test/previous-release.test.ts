import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { writeJsonAtomic } from '../src/json-file.js';
import {
  PREVIOUS_RELEASE_ARTIFACT_PATHS,
  installPreviousRelease,
  previousReleasePaths,
  uninstallPreviousRelease
} from './fixtures/previous-release.js';

const snapshotsDir = fileURLToPath(new URL('./fixtures/previous-release/', import.meta.url));

describe.each(['npx', 'absolute'] as const)('previous-release fixture (%s)', (commandMode) => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'presence-previous-release-'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(homeDir, { recursive: true, force: true });
  });

  it('writes every artifact byte-for-byte as the original installer scripts did', async () => {
    await installPreviousRelease({ homeDir, commandMode });

    for (const relativePath of Object.values(PREVIOUS_RELEASE_ARTIFACT_PATHS)) {
      const actual = await readFile(join(homeDir, relativePath));
      const snapshotName = `${relativePath.replace(/^\./, '').replaceAll('/', '__')}.snap`;
      const original = await readFile(join(snapshotsDir, commandMode, snapshotName));
      expect(actual).toEqual(original);
    }
  });

  it.each(['top-level', 'group'] as const)(
    'treats null %s hooks as empty in old install and uninstall',
    async (position) => {
      const paths = previousReleasePaths(homeDir);
      const hookPaths = [paths.claudeSettings, paths.codexHooks, paths.geminiSettings];
      const input = { theme: 'dark', hooks: position === 'top-level' ? null : { Stop: [{ hooks: null }] } };
      for (const path of hookPaths) {
        await writeJsonAtomic(path, input);
      }

      await installPreviousRelease({ homeDir, commandMode });

      for (const path of hookPaths) {
        expect(await readFile(path, 'utf8')).toContain('"command":');
        await writeJsonAtomic(path, input);
      }

      await uninstallPreviousRelease({ homeDir });

      for (const path of hookPaths) {
        expect(await readFile(path, 'utf8')).toBe(`${JSON.stringify({ theme: 'dark', hooks: {} }, null, 2)}\n`);
      }
    }
  );

  it('preserves foreign hook types and config values through old install and uninstall matchers', async () => {
    await installPreviousRelease({ homeDir, commandMode });
    const paths = previousReleasePaths(homeDir);
    for (const path of [paths.claudeSettings, paths.codexHooks, paths.geminiSettings]) {
      await writeJsonAtomic(path, {
        hooks: {
          Stop: [
            {
              hooks: [
                { command: 'echo keep', type: 'command' },
                { command: 'echo keep prompt', type: 'prompt', prompt: 'keep prompt' },
                { command: 'echo keep without type' },
                { type: 'command', command: 'agent-presence hook --event Stop' },
                { type: 'command', command: 'npx @rivus/agent-presence@0.9.0 hook --event Stop' },
                { type: 'command', command: 'agent-signature hook --event Stop' },
                { type: 'command', command: 'agent-signature.mjs hook --event Stop' },
                { type: 'command', command: '/usr/bin/node /work/team-audit/dist/src/cli.js hook --event Stop' }
              ]
            }
          ]
        }
      });
    }
    await writeJsonAtomic(paths.opencodeConfig, {
      theme: 'dark',
      plugin: [
        'foreign-plugin',
        42,
        null,
        { name: 'foreign-plugin' },
        './plugins/agent-presence.js',
        './plugins/agent-signature.js'
      ]
    });
    await writeJsonAtomic(paths.piSettings, {
      theme: 'dark',
      extensions: ['/work/foreign-extension.ts', paths.piExtension, '', 42, null]
    });

    await installPreviousRelease({ homeDir, commandMode });
    await uninstallPreviousRelease({ homeDir });

    for (const path of [paths.claudeSettings, paths.codexHooks, paths.geminiSettings]) {
      expect(await readFile(path, 'utf8')).toBe(
        `${JSON.stringify(
          {
            hooks: {
              Stop: [
                {
                  hooks: [
                    { command: 'echo keep', type: 'command' },
                    { command: 'echo keep prompt', type: 'prompt', prompt: 'keep prompt' },
                    { command: 'echo keep without type' }
                  ]
                }
              ]
            }
          },
          null,
          2
        )}\n`
      );
    }
    expect(await readFile(paths.opencodeConfig, 'utf8')).toBe(
      `${JSON.stringify({ theme: 'dark', plugin: ['foreign-plugin', 42, null, { name: 'foreign-plugin' }] }, null, 2)}\n`
    );
    expect(await readFile(paths.piSettings, 'utf8')).toBe(
      `${JSON.stringify({ theme: 'dark', extensions: ['/work/foreign-extension.ts'] }, null, 2)}\n`
    );
    await expect(readFile(paths.opencodePlugin)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(paths.piExtension)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
