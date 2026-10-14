import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  deleteWorkerVersion,
  increaseEpoch,
  isDisabled,
  parseRecordFileName,
  queuePaths,
  readEpoch,
  readWorkerVersion,
  recordFileName,
  removeTombstone,
  writeTombstone,
  writeWorkerVersion
} from '../src/queue/files.js';

let dir: string;
let statePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-presence-queue-files-'));
  statePath = join(dir, 'state.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('queuePaths', () => {
  it('names the files every queue release shares next to the state file', () => {
    expect(queuePaths('/work/state.json')).toEqual({
      queueDir: '/work/state.json.queue',
      failedDir: '/work/state.json.queue/failed',
      epoch: '/work/state.json.epoch',
      disabled: '/work/state.json.disabled',
      workerLock: '/work/state.json.worker.lock.db',
      workerVersion: '/work/state.json.worker.v',
      stopRequestPrefix: '/work/state.json.worker.stop.'
    });
  });
});

describe('record file names', () => {
  it('lead with the recorded time in 13 digits and give the id without the extension', () => {
    const name = recordFileName(1_760_000_000_000, 4242, 'ab12');
    expect(name).toBe('1760000000000-4242-ab12.json');
    expect(parseRecordFileName(name)).toEqual({ id: '1760000000000-4242-ab12', recordedAt: 1_760_000_000_000 });
  });

  it('pad an early recorded time so names still sort by time', () => {
    expect(recordFileName(1000, 7, '00ff')).toBe('0000000001000-7-00ff.json');
    expect(parseRecordFileName('0000000001000-7-00ff.json')?.recordedAt).toBe(1000);
  });

  it('refuse a recorded time that does not fit 13 digits', () => {
    expect(() => recordFileName(10 ** 13, 1, 'aaaa')).toThrow(RangeError);
    expect(() => recordFileName(-1, 1, 'aaaa')).toThrow(RangeError);
  });

  it.each([
    '.tmp-1760000000000-1-aaaa.json',
    '1760000000000-1-aaaa.json.tmp',
    '176000000000-1-aaaa.json',
    '1760000000000.json',
    'failed',
    'notes.txt'
  ])('do not parse from %s', (name) => {
    expect(parseRecordFileName(name)).toBeUndefined();
  });
});

describe('epoch', () => {
  it('reads 0 before the first increase, then each increase', async () => {
    expect(await readEpoch(statePath)).toBe(0);
    expect(await increaseEpoch(statePath)).toBe(1);
    expect(await increaseEpoch(statePath)).toBe(2);
    expect(await readEpoch(statePath)).toBe(2);
    expect(await readFile(queuePaths(statePath).epoch, 'utf8')).toBe('2\n');
  });

  it.each(['', 'abc', '-1', '1.5', '1e3', '12 13', '99999999999999999999'])('reads %j as 0', async (text) => {
    await writeFile(queuePaths(statePath).epoch, text);
    expect(await readEpoch(statePath)).toBe(0);
  });

  it('reads decimal text with surrounding whitespace', async () => {
    await writeFile(queuePaths(statePath).epoch, ' 7\n');
    expect(await readEpoch(statePath)).toBe(7);
  });
});

describe('tombstone', () => {
  it('exists from its write until its removal', async () => {
    expect(await isDisabled(statePath)).toBe(false);
    await writeTombstone(statePath);
    expect(await isDisabled(statePath)).toBe(true);
    await removeTombstone(statePath);
    expect(await isDisabled(statePath)).toBe(false);
    await removeTombstone(statePath);
  });

  it('is written into a state directory that does not exist yet', async () => {
    const nested = join(dir, 'missing', 'state.json');
    await writeTombstone(nested);
    expect(await isDisabled(nested)).toBe(true);
  });
});

describe('worker version', () => {
  it('holds the version written until it is deleted, and reads 0 without it', async () => {
    expect(await readWorkerVersion(statePath)).toBe(0);
    await writeWorkerVersion(statePath, 3);
    expect(await readWorkerVersion(statePath)).toBe(3);
    expect(await readFile(queuePaths(statePath).workerVersion, 'utf8')).toBe('3\n');
    expect((await stat(queuePaths(statePath).workerVersion)).mode & 0o777).toBe(0o600);

    await writeWorkerVersion(statePath, 4);
    expect(await readWorkerVersion(statePath)).toBe(4);
    await deleteWorkerVersion(statePath);
    expect(await readWorkerVersion(statePath)).toBe(0);
    await deleteWorkerVersion(statePath);
  });

  it('reads text that is not a version as 0', async () => {
    await writeFile(queuePaths(statePath).workerVersion, 'v2');
    expect(await readWorkerVersion(statePath)).toBe(0);
  });

  it('leaves no temporary file behind', async () => {
    await writeWorkerVersion(statePath, 1);
    await increaseEpoch(statePath);
    expect((await readdir(dir)).sort()).toEqual(['state.json.epoch', 'state.json.worker.v']);
  });
});
