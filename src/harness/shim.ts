import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getHomeDir } from '../config.js';
import { buildAgentPresenceShellCommand } from '../installers.js';
import { presenceShimPath } from './shim-path.js';

export async function writePresenceShim(home = getHomeDir()): Promise<string> {
  const shimPath = presenceShimPath(home);
  const contents = `#!/bin/sh\nexec ${buildAgentPresenceShellCommand([])} "$@"\n`;
  await mkdir(dirname(shimPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${shimPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { mode: 0o755, flag: 'wx' });
    await chmod(temporaryPath, 0o755);
    await rename(temporaryPath, shimPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return shimPath;
}

export async function removePresenceShim(home = getHomeDir()): Promise<void> {
  await rm(presenceShimPath(home), { force: true });
}
