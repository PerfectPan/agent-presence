import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

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
