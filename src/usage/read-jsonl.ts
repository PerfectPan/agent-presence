import { createReadStream, type Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/**
 * Recursively collect `*.jsonl` files under `root`. Files whose last
 * modification predates `sinceMs` are skipped: every entry they hold is older
 * than the window, so parsing them would be wasted work. Missing roots yield an
 * empty list rather than throwing.
 */
export async function listJsonlFiles(root: string, sinceMs: number): Promise<string[]> {
  const found: string[] = [];
  await walk(root, sinceMs, found);
  return found;
}

async function walk(dir: string, sinceMs: number, out: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, sinceMs, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
      continue;
    }
    try {
      const info = await stat(full);
      if (info.mtimeMs >= sinceMs) {
        out.push(full);
      }
    } catch {
      // racing deletion / permission — ignore this file.
    }
  }
}

/**
 * Parse a `.jsonl` file line by line, invoking `onRecord` for every line that
 * parses as a JSON object. Malformed lines and read errors are silently
 * skipped so one corrupt transcript never aborts a scan.
 */
export async function forEachJsonl(file: string, onRecord: (record: unknown) => void): Promise<void> {
  let stream: ReturnType<typeof createReadStream>;
  try {
    stream = createReadStream(file, { encoding: 'utf8' });
  } catch {
    return;
  }

  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        onRecord(JSON.parse(trimmed));
      } catch {
        // skip malformed line
      }
    }
  } catch {
    // skip unreadable file
  } finally {
    rl.close();
    stream.destroy();
  }
}

/** Parse an ISO timestamp to epoch ms, or `null` when absent/invalid. */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
