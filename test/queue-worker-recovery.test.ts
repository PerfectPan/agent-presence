import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ProcessLock } from '@rivus/agent-kit-collab/process-lock';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { kitPlatform } from '../src/kit-platform.js';
import { queuePaths, readWorkerVersion } from '../src/queue/files.js';
import { readWorkerBeat, workerBeatPath } from '../src/queue/worker-beat.js';
import { holdWorkerLock, tryWorkerLock, waitForWorkerLock, WORKER_RECOVERY_WAIT_MS } from '../src/queue/worker-lock.js';
import { WORKER_STUCK_MS } from '../src/queue/worker-watchdog.js';
import { createQueueHome, type QueueHome } from './queue-support.js';

let home: QueueHome;
let lock: ProcessLock | undefined;
const children: ChildProcessWithoutNullStreams[] = [];
beforeEach(async () => {
  home = await createQueueHome();
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
    }
  }
  await lock?.release();
  lock = undefined;
  await home.dispose();
});

async function waitWithVirtualClock(): Promise<number> {
  let elapsed = 0;
  await expect(
    waitForWorkerLock(home.statePath, {
      platform: kitPlatform(),
      monotonic: { now: () => elapsed },
      wall: { now: () => WORKER_STUCK_MS * 2 },
      delay: async (ms) => {
        elapsed += ms;
      },
      waitMs: 20,
      retryMs: 5
    })
  ).rejects.toThrow('timed out');
  return elapsed;
}

describe('a bounded wait without external signaling', () => {
  it.each([
    undefined,
    '{',
    JSON.stringify({ v: 1, pid: process.pid, at: 0 }),
    JSON.stringify({ v: 3, pid: process.pid, at: 0 }),
    JSON.stringify({ v: 2, recovery: 'self-watchdog', pid: process.pid, at: WORKER_STUCK_MS * 2 })
  ])('does not extend for a missing, malformed, old, unknown or fresh beat %s', async (raw) => {
    lock = await tryWorkerLock(home.statePath, kitPlatform());
    if (raw !== undefined) {
      await writeFile(workerBeatPath(home.statePath), raw);
    }
    expect(await waitWithVirtualClock()).toBe(20);
  });

  it('extends only once for a stale beat, without ever signaling the pid in it', async () => {
    lock = await tryWorkerLock(home.statePath, kitPlatform());
    await writeFile(
      workerBeatPath(home.statePath),
      JSON.stringify({ v: 2, recovery: 'self-watchdog', pid: process.pid, at: 0 })
    );
    expect(await waitWithVirtualClock()).toBe(20 + WORKER_RECOVERY_WAIT_MS);
  });

  it('commands remove a preceding beat and never run a watchdog', async () => {
    lock = await tryWorkerLock(home.statePath, kitPlatform());
    if (!lock) {
      throw new Error('no lock');
    }
    await writeFile(workerBeatPath(home.statePath), JSON.stringify({ v: 1, pid: 424_242, at: 0 }));
    const hold = await holdWorkerLock(home.statePath, 1, lock);
    expect(await readWorkerBeat(home.statePath)).toBeUndefined();
    expect(await waitWithVirtualClock()).toBe(20);
    await hold.release();
  });
});

describe('heartbeat lifetime', () => {
  it('keeps a long asynchronous worker operation fresh and removes the beat before releasing', async () => {
    let now = 1_760_000_000_000;
    let tick = (): void => undefined;
    const delay = (_ms: number, signal: AbortSignal): Promise<void> =>
      new Promise((resolve) => {
        const done = (): void => {
          signal.removeEventListener('abort', done);
          resolve();
        };
        tick = done;
        signal.addEventListener('abort', done, { once: true });
      });
    lock = await tryWorkerLock(home.statePath, kitPlatform());
    if (!lock) {
      throw new Error('no lock');
    }
    const hold = await holdWorkerLock(home.statePath, 1, lock, { clock: { now: () => now }, delay, watchdog: true });
    try {
      now += WORKER_STUCK_MS * 2;
      tick();
      await expect.poll(async () => (await readWorkerBeat(home.statePath))?.at).toBe(now);
    } finally {
      await hold.release();
    }
    expect(await readWorkerBeat(home.statePath)).toBeUndefined();
    expect(await readWorkerVersion(home.statePath)).toBe(0);
    tick();
    await expect(readFile(workerBeatPath(home.statePath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('releases the lock and version when metadata setup fails', async () => {
    lock = await tryWorkerLock(home.statePath, kitPlatform());
    if (!lock) {
      throw new Error('no lock');
    }
    await mkdir(workerBeatPath(home.statePath));
    await expect(holdWorkerLock(home.statePath, 1, lock, { clock: { now: () => 0 }, watchdog: true })).rejects.toThrow(
      /directory/i
    );
    expect(await readWorkerVersion(home.statePath)).toBe(0);
    lock = await tryWorkerLock(home.statePath, kitPlatform());
    expect(lock).toBeDefined();
  });
});

const watchdogUrl = new URL('../src/queue/worker-watchdog.ts', import.meta.url).href;
const lockUrl = new URL('../src/queue/worker-lock.ts', import.meta.url).href;
const platformUrl = new URL('../src/kit-platform.ts', import.meta.url).href;
const childScript = `
import { registerHooks } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (specifier.startsWith('.') && specifier.endsWith('.js')) { return next(specifier.slice(0, -3) + '.ts', context); }
    throw error;
  }
}});
const [statePath, mode] = process.argv.slice(1);
const { startWorkerWatchdog } = await import(${JSON.stringify(watchdogUrl)});
const { tryWorkerLock } = await import(${JSON.stringify(lockUrl)});
const { kitPlatform } = await import(${JSON.stringify(platformUrl)});
const lock = await tryWorkerLock(statePath, kitPlatform());
if (!lock) { throw new Error('no lock'); }
const monitor = await startWorkerWatchdog(statePath, { staleMs: 200, pollMs: 20 });
process.stdout.write('ready\\n');
if (mode === 'blocked') {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
} else {
  const timer = mode === 'healthy' ? setInterval(() => monitor.beat(), 20) : undefined;
  if (mode === 'released') { await monitor.stop(); await lock.release(); }
  await sleep(500);
  clearInterval(timer);
  await monitor.stop();
  await lock.release();
  process.stdout.write('done\\n');
}
`;

async function startChild(mode: string): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(
    process.execPath,
    ['--experimental-transform-types', '--input-type=module', '-e', childScript, home.statePath, mode],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: process.env,
      stdio: 'pipe'
    }
  );
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('ready\n')) {
        resolve();
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`child exited before ready: ${code}`)));
  });
  return child;
}

async function request(pid = process.pid): Promise<string> {
  const path = `${queuePaths(home.statePath).stopRequestPrefix}test`;
  await writeFile(path, String(pid));
  return path;
}

describe('self-termination in a real worker process', () => {
  it('kills only its own blocked process for a live request and frees the kernel lock', async () => {
    const child = await startChild('blocked');
    const exit = once(child, 'exit');
    await request();
    expect(await exit).toEqual([null, 'SIGKILL']);
    lock = await tryWorkerLock(home.statePath, kitPlatform());
    expect(lock).toBeDefined();
  });

  it.each(['healthy', 'released'])(
    'leaves a %s worker alive beyond the stale threshold despite a waiting command',
    async (mode) => {
      const child = await startChild(mode);
      const exit = once(child, 'exit');
      await request();
      expect(await exit).toEqual([0, null]);
    }
  );

  it.each(['absent', 'expired', 'dead', 'malformed'])('does not terminate for an %s request', async (kind) => {
    const child = await startChild('blocked');
    if (kind !== 'absent') {
      const path = await request(kind === 'dead' ? 2_147_483_647 : process.pid);
      if (kind === 'expired') {
        await utimes(path, 0, 0);
      }
      if (kind === 'malformed') {
        await writeFile(path, 'not a pid');
      }
    }
    // Synchronize using the child-facing lock, not a signal to a disk-supplied pid.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    await rm(`${queuePaths(home.statePath).stopRequestPrefix}test`, { force: true });
  });
});
