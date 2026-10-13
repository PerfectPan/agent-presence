import { writeLogEvent } from '../log.js';
import { redactSessionId } from '../log-sanitize.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function collectPayloadKeys(value: Record<string, unknown>, keys: Set<string>, prefix = ''): void {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    keys.add(path);
    if (isRecord(child) && ['event', 'session', 'input', 'context'].includes(key)) {
      collectPayloadKeys(child, keys, path);
    }
  }
}

export function describePayloadKeys(payload: unknown): string[] {
  if (!isRecord(payload)) {
    return [];
  }
  const keys = new Set<string>();
  collectPayloadKeys(payload, keys);
  return [...keys].sort();
}

export async function writeHookDiagnostic(options: {
  source: string;
  event: string;
  payload: unknown;
  sessionId?: string;
  project?: string;
}): Promise<void> {
  await writeLogEvent({
    type: 'hook.event',
    source: options.source,
    event: options.event,
    hasSessionId: Boolean(options.sessionId),
    sessionId: redactSessionId(options.sessionId),
    project: options.project,
    payloadKeys: describePayloadKeys(options.payload)
  });
}
