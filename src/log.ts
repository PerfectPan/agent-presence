import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getLogPath } from './config.js';

const LOG_TIME_ZONE = 'Asia/Shanghai';
const CHINA_TIME_OFFSET = '+08:00';
const LOG_TIME_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: LOG_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

export interface LogWriter {
  event(event: Record<string, unknown>): Promise<void>;
}

export async function writeLog(message: string): Promise<void> {
  const path = getLogPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${formatLogEvent({ time: formatLogTime(), level: 'error', app: 'agent-presence', pid: process.pid, message })}\n`, { mode: 0o600 });
}

export async function writeLogEvent(event: Record<string, unknown>): Promise<void> {
  return defaultLogWriter.event(event);
}

export function createLogWriter(context: Record<string, unknown>): LogWriter {
  return {
    event(event: Record<string, unknown>): Promise<void> {
      return appendLogEvent({ ...baseLogContext(), ...context, ...event });
    }
  };
}

const defaultLogWriter = createLogWriter({});

async function appendLogEvent(event: Record<string, unknown>): Promise<void> {
  const path = getLogPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${formatLogEvent({ time: formatLogTime(), level: 'info', ...event })}\n`, { mode: 0o600 });
}

function baseLogContext(): Record<string, unknown> {
  return {
    app: 'agent-presence',
    pid: process.pid
  };
}

export function formatLogTime(date = new Date()): string {
  const parts = Object.fromEntries(LOG_TIME_FORMAT.formatToParts(date).map((part) => [part.type, part.value]));
  const milliseconds = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${milliseconds}${CHINA_TIME_OFFSET}`;
}

export function formatLogEvent(event: Record<string, unknown>): string {
  return Object.entries(event)
    .map(([key, value]) => `${key}=${formatLogValue(value)}`)
    .join(' ');
}

function formatLogValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'string') {
    return quoteLogString(value);
  }
  if (Array.isArray(value)) {
    return quoteLogString(`[${value.map((item) => String(item)).join(',')}]`);
  }
  return quoteLogString(JSON.stringify(value));
}

function quoteLogString(value: string | undefined): string {
  const text = value ?? '';
  if (text !== '' && /^[A-Za-z0-9_./:@+,[\]-]+$/.test(text)) {
    return text;
  }
  return JSON.stringify(text);
}
