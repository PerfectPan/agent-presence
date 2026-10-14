import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProcessLockHeld } from '@rivus/agent-kit-collab/process-lock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { kitPlatform } from '../src/kit-platform.js';
import { acquireLock } from '../src/process-lock.js';
import type { PresenceState } from '../src/state.js';
import { loadState, saveState, withStateLock } from '../src/state-store.js';

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
  dir = await mkdtemp(join(tmpdir(), 'agent-presence-state-store-'));
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

  it('releases the lock when the run throws, and the next caller takes it', async () => {
    await expect(
      withStateLock(statePath, async () => {
        throw new Error('the run failed');
      })
    ).rejects.toThrow('the run failed');

    await expect(withStateLock(statePath, async () => 'again')).resolves.toBe('again');
  });
});

describe('acquireLock', () => {
  const never = new AbortController().signal;

  /** Let pending registrations run; `setImmediate` stays real, so this works over frozen fake timers. */
  async function turns(count: number): Promise<void> {
    for (let turn = 0; turn < count; turn += 1) {
      await new Promise((resolveTurn) => setImmediate(resolveTurn));
    }
  }

  it('hands the lock to a waiter of this process when the holder releases it, without waiting on a timer', async () => {
    const lockPath = `${statePath}.lock.db`;
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const holder = await acquireLock(lockPath, never);
      const waiting = acquireLock(lockPath, never);
      await turns(5);
      await holder.release();
      // Resolving takes only the in-memory turn: no timer fires between the release and the waiter's lock.
      const lock = await waiting;
      await lock.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an aborted waiter with the signal reason, which then does not block the next waiter', async () => {
    const lockPath = `${statePath}.lock.db`;
    const holder = await acquireLock(lockPath, never);
    const reason = new Error('stop waiting');
    const controller = new AbortController();
    const waiting = acquireLock(lockPath, controller.signal, { retryMs: 5 });
    await turns(5);

    controller.abort(reason);

    await expect(waiting).rejects.toBe(reason);
    await holder.release();
    const next = await acquireLock(lockPath, never);
    await next.release();
    await expect(isProcessLockHeld(kitPlatform(), lockPath)).resolves.toBe(false);
  });
});

describe('loadState', () => {
  async function loadRaw(raw: unknown): Promise<PresenceState> {
    await writeFile(statePath, JSON.stringify(raw), { mode: 0o600 });
    return loadState(statePath);
  }

  it('loads what saveState wrote', async () => {
    const state: PresenceState = {
      sessions: {
        a: { id: 'a', source: 'codex', kind: 'coding', status: 'running', startedAt: 10, lastHeartbeatAt: 20 },
        b: {
          id: 'b',
          source: 'claude',
          kind: 'coding',
          status: 'finished',
          startedAt: 10,
          lastHeartbeatAt: 30,
          finishedAt: 30,
          project: '/work/repo'
        }
      },
      lastSlotUpdateAt: 40,
      lastValue: '2 agents',
      pendingSlotFlushAt: 100,
      usageBadges: { '1': '2.1M · $4.50' },
      usageBadgesAt: 50,
      usageSnapshots: { '1': { codex: { totalTokens: 100, costUsd: null, scannedAt: 50 } } }
    };

    await saveState(state, statePath);

    expect(await loadState(statePath)).toEqual(state);
  });

  it('reads the agent of a session written before sources existed from its kind', async () => {
    const state = await loadRaw({
      sessions: { a: { id: 'a', kind: 'claude', status: 'running', startedAt: 10, lastHeartbeatAt: 20 } }
    });

    expect(state.sessions.a).toEqual({
      id: 'a',
      source: 'claude',
      kind: 'coding',
      status: 'running',
      startedAt: 10,
      lastHeartbeatAt: 20,
      finishedAt: undefined,
      project: undefined
    });
  });

  it('loads invalid values as missing and drops sessions it cannot read', async () => {
    const state = await loadRaw({
      sessions: {
        badProject: { id: 'p', source: 'codex', status: 'running', startedAt: 10, lastHeartbeatAt: 20, project: 7 },
        noSource: { id: 'n', kind: 'coding', status: 'running', startedAt: 10, lastHeartbeatAt: 20 },
        badStatus: { id: 's', source: 'codex', status: 'paused', startedAt: 10, lastHeartbeatAt: 20 },
        noStart: { id: 'z', source: 'codex', status: 'running', startedAt: 0, lastHeartbeatAt: 20 },
        running: { id: 'r', source: 'codex', status: 'running', startedAt: 10, lastHeartbeatAt: 20, finishedAt: 15 }
      },
      lastSlotUpdateAt: 'soon',
      lastValue: 5,
      pendingSlotFlushAt: 'later',
      usageBadges: 'none'
    });

    expect(Object.keys(state.sessions).sort()).toEqual(['badProject', 'running']);
    expect(state.sessions.badProject?.project).toBeUndefined();
    expect(state.sessions.running?.finishedAt).toBeUndefined();
    expect(state).toMatchObject({ lastSlotUpdateAt: 0, lastValue: '' });
    expect(state.pendingSlotFlushAt).toBeUndefined();
    expect(state.usageBadges).toBeUndefined();
  });

  it('drops top-level fields it does not know when it saves', async () => {
    const state = await loadRaw({ sessions: {}, laterReleaseField: { kept: false } });
    await saveState(state, statePath);

    expect(JSON.parse(await readFile(statePath, 'utf8'))).not.toHaveProperty('laterReleaseField');
  });

  it('loads a file that is not a JSON object as an empty state', async () => {
    expect(await loadRaw(['not', 'state'])).toEqual({ sessions: {}, lastSlotUpdateAt: 0, lastValue: '' });
  });
});
