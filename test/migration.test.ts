import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasLegacyHomeToMigrate, migrateLegacyHome } from '../src/migration.js';

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
    await expect(readFile(join(home, '.agent-presence', 'config.json'), 'utf8')).resolves.toBe('{"slot_id":"slot_legacy"}');
    await expect(readFile(join(legacyHome, 'config.json'), 'utf8')).resolves.toBe('{"slot_id":"slot_legacy"}');
  });

  it('does not overwrite existing destination files', async () => {
    home = await mkdtemp(join(tmpdir(), 'agent-presence-migration-test-'));
    vi.stubEnv('HOME', home);
    const legacyHome = join(home, '.codex', 'agent-signature');
    const defaultHome = join(home, '.agent-presence');
    await mkdir(legacyHome, { recursive: true });
    await mkdir(defaultHome, { recursive: true });
    await writeFile(join(legacyHome, 'config.json'), '{"slot_id":"slot_legacy"}');
    await writeFile(join(defaultHome, 'config.json'), '{"slot_id":"slot_new"}');

    const result = await migrateLegacyHome({ confirm: async () => true });

    expect(result.status).toBe('migrated');
    expect(result.copied).toEqual([]);
    expect(result.skipped).toEqual(['config.json']);
    await expect(readFile(join(defaultHome, 'config.json'), 'utf8')).resolves.toBe('{"slot_id":"slot_new"}');
  });
});
