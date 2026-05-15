import { cp, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getDefaultHomeDir, getLegacyHomeDir } from './config.js';

const MIGRATED_ENTRIES = ['config.json', 'state.json', 'agent-presence.log', 'agent-signature.log', 'runtime', 'bin'];

export interface LegacyHomeMigrationResult {
  status: 'not-needed' | 'skipped' | 'migrated';
  from: string;
  to: string;
  copied: string[];
  skipped: string[];
}

export async function hasLegacyHomeToMigrate(): Promise<boolean> {
  if (process.env.AGENT_PRESENCE_HOME || process.env.AGENT_SIGNATURE_HOME) {
    return false;
  }
  const legacyHome = getLegacyHomeDir();
  const defaultHome = getDefaultHomeDir();
  if (legacyHome === defaultHome || !(await exists(legacyHome))) {
    return false;
  }
  return (await existingEntries(legacyHome)).length > 0;
}

export async function migrateLegacyHome(options: { confirm: () => Promise<boolean> }): Promise<LegacyHomeMigrationResult> {
  const from = getLegacyHomeDir();
  const to = getDefaultHomeDir();
  if (!(await hasLegacyHomeToMigrate())) {
    return { status: 'not-needed', from, to, copied: [], skipped: [] };
  }

  const approved = await options.confirm();
  if (!approved) {
    return { status: 'skipped', from, to, copied: [], skipped: await existingEntries(from) };
  }

  await mkdir(to, { recursive: true, mode: 0o700 });
  const copied: string[] = [];
  const skipped: string[] = [];

  for (const entry of await existingEntries(from)) {
    const source = join(from, entry);
    const target = join(to, entry);
    if (await exists(target)) {
      skipped.push(entry);
      continue;
    }
    await cp(source, target, { recursive: true, errorOnExist: true });
    copied.push(entry);
  }

  return { status: 'migrated', from, to, copied, skipped };
}

async function existingEntries(home: string): Promise<string[]> {
  const entries: string[] = [];
  for (const entry of MIGRATED_ENTRIES) {
    if (await exists(join(home, entry))) {
      entries.push(entry);
    }
  }
  return entries;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
