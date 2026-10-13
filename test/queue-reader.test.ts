import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { queuePaths, type QueueClock } from '../src/queue/files.js';
import {
  deleteQueueFile,
  FAILED_MAX_AGE_MS,
  listQueue,
  moveToFailed,
  readQueueFile,
  removeExpiredFiles,
  TEMPORARY_MAX_AGE_MS,
  type QueueFile
} from '../src/queue/reader.js';

const NOW = 1_760_000_000_000;

let dir: string;
let statePath: string;
let queueDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-presence-queue-reader-'));
  statePath = join(dir, 'state.json');
  queueDir = queuePaths(statePath).queueDir;
  await mkdir(queueDir, { recursive: true, mode: 0o700 });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fixedClock(now: number): QueueClock {
  return { now: () => now };
}

function errorRecord(id: string, recordedAt: number, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id,
    recordedAt,
    epoch: 0,
    kind: 'error',
    code: 'resolver-failed',
    message: 'resolver threw',
    ...fields
  };
}

async function put(name: string, content: unknown): Promise<void> {
  await writeFile(join(queueDir, name), typeof content === 'string' ? content : JSON.stringify(content), {
    mode: 0o600
  });
}

async function onlyRecord(): Promise<QueueFile> {
  const { records } = await listQueue(statePath);
  expect(records).toHaveLength(1);
  const [file] = records;
  if (!file) {
    throw new Error('no record listed');
  }
  return file;
}

async function setAge(path: string, ageMs: number): Promise<void> {
  const time = new Date(NOW - ageMs);
  await utimes(path, time, time);
}

describe('listQueue', () => {
  it('lists records by recorded time, then by file name, with the id from the name', async () => {
    await put('1760000000002-9-aaaa.json', '{}');
    await put('1760000000001-9-ffff.json', '{}');
    await put('1760000000001-10-0000.json', '{}');
    await put('1760000000001-9-0000.json', '{}');

    const { records } = await listQueue(statePath);

    expect(records.map((file) => file.id)).toEqual([
      '1760000000001-10-0000',
      '1760000000001-9-0000',
      '1760000000001-9-ffff',
      '1760000000002-9-aaaa'
    ]);
    expect(records[0]).toEqual({
      id: '1760000000001-10-0000',
      name: '1760000000001-10-0000.json',
      path: join(queueDir, '1760000000001-10-0000.json'),
      recordedAt: 1_760_000_000_001
    });
  });

  it('reports .tmp- files apart and leaves failed/ and other names out', async () => {
    await put('1760000000001-9-aaaa.json', '{}');
    await put('.tmp-1760000000002-9-bbbb.json', '{"v":');
    await put('notes.txt', 'x');
    await put('1760000000003-9-cccc.json.tmp', '{}');
    await mkdir(join(queueDir, 'failed'));
    await writeFile(join(queueDir, 'failed', '1760000000000-9-dddd.json'), '{}');

    const listing = await listQueue(statePath);

    expect(listing.records.map((file) => file.id)).toEqual(['1760000000001-9-aaaa']);
    expect(listing.temporary).toEqual([join(queueDir, '.tmp-1760000000002-9-bbbb.json')]);
  });

  it('lists a queue directory that does not exist as empty', async () => {
    await rm(queueDir, { recursive: true });
    expect(await listQueue(statePath)).toEqual({ records: [], temporary: [] });
  });
});

describe('readQueueFile', () => {
  it('parses a record whose id and recorded time match its name', async () => {
    const record = errorRecord('1760000000001-9-aaaa', 1_760_000_000_001);
    await put('1760000000001-9-aaaa.json', record);

    expect(await readQueueFile(await onlyRecord())).toEqual({ status: 'record', record });
  });

  it('leaves a record of a higher version unparsed', async () => {
    await put('1760000000001-9-aaaa.json', { v: 2, kind: 'from-a-later-release', id: 7 });

    expect(await readQueueFile(await onlyRecord())).toEqual({ status: 'newer', v: 2 });
    expect(await readQueueFile(await onlyRecord(), 2)).toMatchObject({ status: 'bad' });
  });

  it.each([
    ['text that is not JSON', 'prompt text {'],
    ['no v', { kind: 'error' }],
    ['a v that is not a non-negative integer', errorRecord('1760000000001-9-aaaa', 1_760_000_000_001, { v: 0.5 })],
    ['an unknown kind', errorRecord('1760000000001-9-aaaa', 1_760_000_000_001, { kind: 'later-kind' })],
    ['a missing field', errorRecord('1760000000001-9-aaaa', 1_760_000_000_001, { message: undefined })],
    ['an id that is not its name', errorRecord('1760000000001-9-bbbb', 1_760_000_000_001)],
    ['a recorded time that is not its name', errorRecord('1760000000001-9-aaaa', 1_760_000_000_002)]
  ])('reports a record with %s as bad, without its content', async (_name, content) => {
    await put('1760000000001-9-aaaa.json', content);

    const read = await readQueueFile(await onlyRecord());
    expect(read.status).toBe('bad');
    expect(JSON.stringify(read)).not.toContain('prompt text');
  });

  it('reports a file deleted after the listing as missing', async () => {
    await put('1760000000001-9-aaaa.json', errorRecord('1760000000001-9-aaaa', 1_760_000_000_001));
    const file = await onlyRecord();
    await deleteQueueFile(file);

    expect(await readQueueFile(file)).toEqual({ status: 'missing' });
    await deleteQueueFile(file);
  });
});

describe('failed and temporary files', () => {
  it('moves a bad record into failed/ under its name, dated by the clock', async () => {
    await put('1760000000001-9-aaaa.json', 'not json');
    const file = await onlyRecord();

    await moveToFailed(statePath, file, fixedClock(NOW));

    expect((await listQueue(statePath)).records).toEqual([]);
    const failed = join(queuePaths(statePath).failedDir, '1760000000001-9-aaaa.json');
    expect((await stat(failed)).mtimeMs).toBe(NOW);
    await moveToFailed(statePath, file, fixedClock(NOW));
  });

  it('removes .tmp- files older than an hour and failed records older than seven days', async () => {
    const { failedDir } = queuePaths(statePath);
    await mkdir(failedDir);
    const oldTemporary = join(queueDir, '.tmp-1760000000001-9-aaaa.json');
    const newTemporary = join(queueDir, '.tmp-1760000000002-9-bbbb.json');
    const oldFailed = join(failedDir, '1760000000003-9-cccc.json');
    const newFailed = join(failedDir, '1760000000004-9-dddd.json');
    for (const path of [oldTemporary, newTemporary, oldFailed, newFailed]) {
      await writeFile(path, '{}');
    }
    await put('1760000000005-9-eeee.json', '{}');
    await setAge(oldTemporary, TEMPORARY_MAX_AGE_MS + 1);
    await setAge(newTemporary, TEMPORARY_MAX_AGE_MS - 1000);
    await setAge(oldFailed, FAILED_MAX_AGE_MS + 1);
    await setAge(newFailed, FAILED_MAX_AGE_MS - 1000);
    await setAge(join(queueDir, '1760000000005-9-eeee.json'), FAILED_MAX_AGE_MS * 2);

    expect(await removeExpiredFiles(statePath, fixedClock(NOW))).toEqual({ temporary: 1, failed: 1 });

    expect((await readdir(queueDir)).sort()).toEqual([
      '.tmp-1760000000002-9-bbbb.json',
      '1760000000005-9-eeee.json',
      'failed'
    ]);
    expect(await readdir(failedDir)).toEqual(['1760000000004-9-dddd.json']);
  });
});
