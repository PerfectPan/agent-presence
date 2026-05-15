import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getLogPath } from './config.js';

export async function writeLog(message: string): Promise<void> {
  const path = getLogPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `[${new Date().toISOString()}] ${message}\n`, { mode: 0o600 });
}

export async function writeLogEvent(event: Record<string, unknown>): Promise<void> {
  const path = getLogPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`, { mode: 0o600 });
}
