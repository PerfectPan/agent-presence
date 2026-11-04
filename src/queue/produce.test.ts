import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { queuePaths, RECORD_VERSION } from './files.js';
import { writeRecord, type RecordBody } from './produce.js';

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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-presence-queue-produce-'));
  statePath = join(dir, 'state.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

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
