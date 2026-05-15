import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupMigratedLegacyHome, hasLegacyHomeToMigrate, migrateLegacyHome } from '../src/migration.js';

describe('legacy home migration', () => {
  let home: string | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (home) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it('copies legacy files to ~/.agent-presence when setup migration is approved', async () => {
    home = await mkdtemp(join(tmpdir(), 'agent-presence-migration-test-'));
    vi.stubEnv('HOME', home);
    const legacyHome = join(home, '.codex', 'agent-signature');
    await mkdir(legacyHome, { recursive: true });
    await writeFile(join(legacyHome, 'config.json'), '{"slot_id":"slot_legacy"}');
    await writeFile(join(legacyHome, 'state.json'), '{"sessions":{}}');

    await expect(hasLegacyHomeToMigrate()).resolves.toBe(true);
    const result = await migrateLegacyHome({ confirm: async () => true });

    expect(result.status).toBe('migrated');
    expect(result.copied).toEqual(['config.json', 'state.json']);
    expect(result.removed).toEqual(['config.json', 'state.json']);
    await expect(readFile(join(home, '.agent-presence', 'config.json'), 'utf8')).resolves.toBe('{"slot_id":"slot_legacy"}');
    await expect(stat(join(legacyHome, 'config.json'))).rejects.toThrow();
  });

  it('does not overwrite existing destination files', async () => {
    home = await mkdtemp(join(tmpdir(), 'agent-presence-migration-test-'));
    vi.stubEnv('HOME', home);
    const legacyHome = join(home, '.codex', 'agent-signature');
    const defaultHome = join(home, '.agent-presence');
    await mkdir(legacyHome, { recursive: true });
    await mkdir(defaultHome, { recursive: true });
    await writeFile(join(legacyHome, 'config.json'), '{"slot_id":"slot_legacy"}');
    await writeFile(join(legacyHome, 'state.json'), '{"sessions":{}}');
    await writeFile(join(defaultHome, 'config.json'), '{"slot_id":"slot_new"}');

    const result = await migrateLegacyHome({ confirm: async () => true });

    expect(result.status).toBe('migrated');
    expect(result.copied).toEqual(['state.json']);
    expect(result.skipped).toEqual(['config.json']);
    expect(result.removed).toEqual(['config.json', 'state.json']);
    await expect(readFile(join(defaultHome, 'config.json'), 'utf8')).resolves.toBe('{"slot_id":"slot_new"}');
    await expect(readFile(join(defaultHome, 'state.json'), 'utf8')).resolves.toBe('{"sessions":{}}');
    await expect(stat(join(legacyHome, 'config.json'))).rejects.toThrow();
    await expect(stat(join(legacyHome, 'state.json'))).rejects.toThrow();
  });

  it('cleans already migrated legacy files before checking whether a prompt is needed', async () => {
    home = await mkdtemp(join(tmpdir(), 'agent-presence-migration-test-'));
    vi.stubEnv('HOME', home);
    const legacyHome = join(home, '.codex', 'agent-signature');
    const defaultHome = join(home, '.agent-presence');
    await mkdir(legacyHome, { recursive: true });
    await mkdir(defaultHome, { recursive: true });
    await writeFile(join(legacyHome, 'config.json'), '{"slot_id":"slot_legacy"}');
    await writeFile(join(defaultHome, 'config.json'), '{"slot_id":"slot_new"}');
    await writeFile(join(legacyHome, 'state.json'), '{"sessions":{"old":{}}}');
    await writeFile(join(defaultHome, 'state.json'), '{"sessions":{}}');
    await writeFile(join(legacyHome, 'agent-presence.log'), 'old log');
    await writeFile(join(defaultHome, 'agent-presence.log'), 'new log');
    await writeFile(join(legacyHome, 'notes.txt'), 'keep me');

    const cleanup = await cleanupMigratedLegacyHome();

    expect(cleanup.removed).toEqual(['config.json', 'state.json', 'agent-presence.log']);
    await expect(hasLegacyHomeToMigrate()).resolves.toBe(false);
    const confirm = vi.fn(async () => true);
    const result = await migrateLegacyHome({ confirm });

    expect(result.status).toBe('not-needed');
    expect(confirm).not.toHaveBeenCalled();
    await expect(readdir(legacyHome)).resolves.toEqual(['notes.txt']);
  });
});
