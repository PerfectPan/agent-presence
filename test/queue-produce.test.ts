import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireProcessLock, type ProcessLock } from '@rivus/agent-kit-collab/process-lock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { kitPlatform } from '../src/kit-platform.js';
import { queuePaths, RECORD_VERSION, writeTombstone, writeWorkerVersion } from '../src/queue/files.js';
import { checkWorkerLock, produceRecord, writeRecord, type RecordBody } from '../src/queue/produce.js';
import { listQueue, readQueueFile } from '../src/queue/reader.js';
import { usageEventFromPayload } from '../src/usage-events.js';

// Lets a test stop a write right after the file's content is on disk, before anything else happens to it.
const afterWriteFile = vi.hoisted(() => ({ current: undefined as (() => Promise<void>) | undefined }));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      await actual.writeFile(...args);
      await afterWriteFile.current?.();
    }
  };
});

const NOW = 1_760_000_000_000;
const clock = { now: () => NOW };

const heartbeat: RecordBody = {
  kind: 'event',
  source: 'codex',
  event: 'Heartbeat',
  sessionId: 's1',
  project: '/work/repo',
  payloadKeys: ['hook_event_name', 'session_id']
};

let dir: string;
let statePath: string;
let lock: ProcessLock | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-presence-queue-produce-'));
  statePath = join(dir, 'state.json');
});

afterEach(async () => {
  await lock?.release();
  lock = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function holdWorkerLock(): Promise<void> {
  const held = await acquireProcessLock(kitPlatform(), queuePaths(statePath).workerLock);
  if (!held.ok) {
    throw new Error('worker lock is held');
  }
  lock = held.value;
}

describe('writeRecord', () => {
  it('writes an owner-only record named by its recorded time, pid and random part, with its header', async () => {
    const id = await writeRecord(statePath, heartbeat, { epoch: 3, clock });

    expect(id).toMatch(new RegExp(`^${NOW}-${process.pid}-[0-9a-f]{4}$`));
    const { queueDir } = queuePaths(statePath);
    expect((await stat(queueDir)).mode & 0o777).toBe(0o700);
    expect(await readdir(queueDir)).toEqual([`${id}.json`]);
    const path = join(queueDir, `${id}.json`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      v: RECORD_VERSION,
      id,
      recordedAt: NOW,
      epoch: 3,
      ...heartbeat
    });
  });

  it('writes records the reader parses back unchanged, for every kind', async () => {
    const usage = usageEventFromPayload('dsh', { model: 'deepseek-v4-pro', usage: { inputTokens: 5 } }, NOW);
    const bodies: RecordBody[] = [
      heartbeat,
      {
        kind: 'event',
        source: 'dsh',
        event: 'Stop',
        sessionId: 's2',
        ...(usage ? { usage: { ...usage } } : {}),
        scanEnv: {},
        payloadKeys: ['model', 'usage']
      },
      { kind: 'skip', code: 'ignored-event', source: 'pi', nativeEvent: 'session_start', payloadKeys: [] },
      { kind: 'error', code: 'hook-load-failed', message: 'hook module did not load' }
    ];
    for (const body of bodies) {
      await writeRecord(statePath, body, { epoch: 0, clock, version: 2 });
    }

    const { records } = await listQueue(statePath);
    const read = await Promise.all(records.map((file) => readQueueFile(file, 2)));
    expect(read.map((result) => (result.status === 'record' ? result.record.kind : result.status)).sort()).toEqual([
      'error',
      'event',
      'event',
      'skip'
    ]);
    for (const result of read) {
      expect(result.status).toBe('record');
      expect(result.status === 'record' && result.record.v).toBe(2);
    }
  });

  it('skips a name this process already used instead of replacing that record', async () => {
    const hex = ['aaaa', 'aaaa', 'bbbb'];
    const randomHex = (): string => hex.shift() ?? 'zzzz';

    const first = await writeRecord(statePath, heartbeat, { epoch: 0, clock, randomHex });
    const second = await writeRecord(statePath, { ...heartbeat, sessionId: 's2' }, { epoch: 0, clock, randomHex });

    expect([first, second]).toEqual([`${NOW}-${process.pid}-aaaa`, `${NOW}-${process.pid}-bbbb`]);
    const { records } = await listQueue(statePath);
    const sessions = await Promise.all(
      records.map(async (file) => {
        const read = await readQueueFile(file);
        return read.status === 'record' && read.record.kind === 'event' ? read.record.sessionId : read.status;
      })
    );
    expect(sessions).toEqual(['s1', 's2']);
    expect((await listQueue(statePath)).temporary).toEqual([]);
  });

  it('keeps every record of a burst written at the same time by one process', async () => {
    const ids = await Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        writeRecord(statePath, { ...heartbeat, sessionId: `s${index}` }, { epoch: 0, clock })
      )
    );

    expect(new Set(ids).size).toBe(200);
    const listing = await listQueue(statePath);
    expect(listing.records).toHaveLength(200);
    expect(listing.temporary).toEqual([]);
  });

  it('makes a record visible only once its whole content is written', async () => {
    let resume: () => void = () => undefined;
    const paused = new Promise<void>((resolvePaused) => {
      afterWriteFile.current = () => {
        afterWriteFile.current = undefined;
        resolvePaused();
        return new Promise((resolveResume) => {
          resume = resolveResume;
        });
      };
    });

    const writing = writeRecord(statePath, heartbeat, { epoch: 0, clock });
    await paused;
    const whileWritten = await listQueue(statePath);
    resume();
    const id = await writing;

    expect(whileWritten.records).toEqual([]);
    expect(whileWritten.temporary).toEqual([join(queuePaths(statePath).queueDir, `.tmp-${id}.json`)]);
    expect((await listQueue(statePath)).records.map((file) => file.id)).toEqual([id]);
  });

  it('rejects when the queue directory cannot be written, leaving no record', async (context) => {
    if (process.getuid?.() === 0) {
      context.skip();
    }
    const { queueDir } = queuePaths(statePath);
    await mkdir(queueDir, { recursive: true, mode: 0o700 });
    await chmod(queueDir, 0o500);
    try {
      await expect(writeRecord(statePath, heartbeat, { epoch: 0, clock })).rejects.toThrow('EACCES');
      expect(await readdir(queueDir)).toEqual([]);
    } finally {
      await chmod(queueDir, 0o700);
    }
  });
});

describe('produceRecord', () => {
  it('records nothing while the tombstone exists', async () => {
    await writeTombstone(statePath);

    expect(await produceRecord(statePath, heartbeat, { clock })).toEqual({ status: 'disabled' });
    expect(await listQueue(statePath)).toEqual({ records: [], temporary: [] });
  });

  it('copies the epoch from the epoch file into the record', async () => {
    await writeFile(queuePaths(statePath).epoch, '4\n');

    const outcome = await produceRecord(statePath, heartbeat, { clock });

    expect(outcome).toMatchObject({ status: 'recorded' });
    const [file] = (await listQueue(statePath)).records;
    const read = file ? await readQueueFile(file) : undefined;
    expect(read?.status === 'record' && read.record.epoch).toBe(4);
  });

  it('starts a worker when no process holds the worker lock', async () => {
    expect(await produceRecord(statePath, heartbeat, { clock })).toMatchObject({
      status: 'recorded',
      startWorker: true
    });
    // The check created no lock file.
    expect(await readdir(dir)).toEqual(['state.json.queue']);
  });

  it.each([
    ['has not written its version', undefined, true],
    ['is of an older version', 1, true],
    ['is of the same version', 2, false],
    ['is of a newer version', 3, false]
  ])('when the lock holder %s, starts a worker: %s', async (_name, holderVersion, startWorker) => {
    await mkdir(dir, { recursive: true });
    await holdWorkerLock();
    if (holderVersion !== undefined) {
      await writeWorkerVersion(statePath, holderVersion);
    }

    expect(await checkWorkerLock(statePath)).toEqual({ held: true, version: holderVersion ?? 0 });
    expect(await produceRecord(statePath, heartbeat, { clock, version: 2 })).toMatchObject({
      status: 'recorded',
      startWorker
    });
  });

  it('starts a worker once the holder releases the lock, whatever version it left behind', async () => {
    await holdWorkerLock();
    await writeWorkerVersion(statePath, 5);
    await lock?.release();
    lock = undefined;

    expect(await checkWorkerLock(statePath)).toEqual({ held: false });
    expect(await produceRecord(statePath, heartbeat, { clock })).toMatchObject({ startWorker: true });
  });
});
