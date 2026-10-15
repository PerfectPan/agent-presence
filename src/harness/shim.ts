import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getHomeDir } from '../config.js';
import { buildAgentPresenceShellCommand } from '../installers.js';

export async function writePresenceShim(home = getHomeDir()): Promise<string> {
  const shimPath = join(home, 'bin', 'agent-presence');
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
  await rm(join(home, 'bin', 'agent-presence'), { force: true });
}
