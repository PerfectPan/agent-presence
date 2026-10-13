import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { withStateLock } from '../src/state.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Another process that takes the kit lock on the state lock path, reports `held`, and releases it when told to.
const holderScript = `
import { acquireProcessLock } from '@rivus/agent-kit-collab/process-lock';
import { createNodePlatform } from '@rivus/agent-kit/node';
const held = await acquireProcessLock(createNodePlatform(), process.argv[1], { wait: true });
if (!held.ok) process.exit(2);
process.stdout.write('held\\n');
process.stdin.once('data', async () => {
  await held.value.release();
  process.exit(0);
});
`;

let dir: string;
let statePath: string;
let holder: ChildProcessWithoutNullStreams | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-presence-state-lock-'));
  statePath = join(dir, 'state.json');
});

afterEach(async () => {
  if (holder && holder.exitCode === null && holder.signalCode === null) {
    holder.kill('SIGKILL');
    await once(holder, 'exit');
  }
  holder = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function startHolder(): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', holderScript, `${statePath}.lock.db`], {
    cwd: repoRoot
  });
  holder = child;
  const [chunk] = (await once(child.stdout, 'data')) as [Buffer];
  expect(chunk.toString()).toBe('held\n');
  return child;
}

describe('withStateLock', () => {
  it('runs once another process that holds the state lock releases it', async () => {
    const child = await startHolder();

    const locked = withStateLock(statePath, async () => 'locked');
    child.stdin.write('release\n');

    await expect(locked).resolves.toBe('locked');
  });

  it('times out without running when the holder keeps the lock past the wait', async () => {
    await startHolder();
    let ran = false;

    await expect(
      withStateLock(
        statePath,
        async () => {
          ran = true;
        },
        { waitMs: 50 }
      )
    ).rejects.toThrow(`timed out waiting for state lock: ${statePath}.lock.db`);
    expect(ran).toBe(false);
  });

  it('takes the lock that a killed holder left', async () => {
    const child = await startHolder();
    child.kill('SIGKILL');
    await once(child, 'exit');

    await expect(withStateLock(statePath, async () => 'locked')).resolves.toBe('locked');
  });

  it('runs concurrent callers in one process one at a time', async () => {
    let inside = 0;
    let overlapped = false;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        withStateLock(statePath, async () => {
          inside += 1;
          overlapped ||= inside > 1;
          await new Promise((resolveTurn) => setImmediate(resolveTurn));
          inside -= 1;
        })
      )
    );

    expect(overlapped).toBe(false);
  });

  it('leaves the lock directory of a previous release alone', async () => {
    const oldLockDir = `${statePath}.lock`;
    await mkdir(oldLockDir, { recursive: true, mode: 0o700 });

    await expect(withStateLock(statePath, async () => 'locked')).resolves.toBe('locked');
    expect((await stat(oldLockDir)).isDirectory()).toBe(true);
  });
});
