import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { hasNodeErrorCode } from '../json-file.js';
import { randomHex, queuePaths } from './files.js';

// Two processes of different releases read the beat: the holder writes it and a command whose wait for the worker
// lock ran out reads it to tell a stuck holder from one that is merely between rounds. Like every queue file its
// format is fixed for all releases, and it stays free of schemas: the fields are JSON with plain numbers.

/** The beat format version; a reader that does not know it leaves the file alone. */
const BEAT_VERSION = 1;

/** What the holder of the worker lock last wrote: the round it finished, and the pid to signal when it is stuck. */
export interface WorkerBeat {
  readonly v: number;
  readonly pid: number;
  /** Wall-clock milliseconds of the holder's clock when it wrote the beat. */
  readonly at: number;
}

export function workerBeatPath(statePath: string): string {
  return `${queuePaths(statePath).workerVersion}.beat`;
}

/** A beat a reader can act on: the fields are the right types and in range, or there is no beat. */
function parseBeat(raw: unknown): WorkerBeat | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const { v, pid, at } = raw as Record<string, unknown>;
  if (
    v !== BEAT_VERSION ||
    typeof pid !== 'number' ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    typeof at !== 'number' ||
    !Number.isInteger(at) ||
    at < 0
  ) {
    return undefined;
  }
  return { v, pid, at };
}

/** The holder's last beat, or `undefined` when there is none or it does not parse. */
export async function readWorkerBeat(statePath: string): Promise<WorkerBeat | undefined> {
  let text: string;
  try {
    text = await readFile(workerBeatPath(statePath), 'utf8');
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
  try {
    return parseBeat(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * Write the holder's beat, replacing the file atomically. A failed write throws: the caller treats it like any
 * failed iteration, and a holder that cannot beat is one a takeover may soon replace.
 */
export async function writeWorkerBeat(statePath: string, pid: number, at: number): Promise<void> {
  const path = workerBeatPath(statePath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${pid}.${randomHex(4)}.tmp`;
  const beat: WorkerBeat = { v: BEAT_VERSION, pid, at };
  try {
    await writeFile(temporary, `${JSON.stringify(beat)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
