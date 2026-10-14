import { getStatePath, loadConfig } from '../../config.js';
import { produceRecord, type RecordBody } from '../../queue/produce.js';
import type { RecordUsage } from '../../queue/schema.js';
import { startWorkerProcess, type StartWorker } from '../../queue/start-worker.js';
import { isSessionBoundaryEvent } from '../../state.js';
import { usageEventFromPayload } from '../../usage-events.js';
import { hasFlag, optionValue } from '../args.js';
import { errorMessage } from '../errors.js';
import { describePayloadKeys } from '../hook-diagnostics.js';
import { interpretAgentHook } from '../hook-interpret.js';
import { recordHookFailure, writeHookOutput } from '../hook-output.js';
import { BUILTIN_SOURCE_PLUGINS } from '../hook-context.js';
import { readStdinJson } from '../io.js';
import { resolveHookContextForSource, type SourceDiagnostics } from '../../sources.js';

// The hook is the queue's producer (Plan 0003 3.3): it interprets the payload in process, writes one record, and
// starts a worker when no process of this release or a newer one holds the worker lock. It takes no lock, writes no
// log line (3.11) and no stop request, and prints its output and exits 0 in every case: a failed read, write or start
// loses the event (3.10). The direct application path stays in `src/cli/hook-apply.ts` until Q2 deletes it; the
// event-table test uses it as the oracle.

// Tests run the worker in process instead of detached (test/hook-producer-support.ts).
let startWorker: StartWorker = startWorkerProcess;

/** Test-only: route the producer's worker starts through `override` until restored with `undefined`. */
export function setHookStartWorkerForTests(override: StartWorker | undefined): void {
  startWorker = override ?? startWorkerProcess;
}

/** The queue writes of one hook run: whether a worker is wanted, and whether the run already recorded its failure. */
interface HookProduction {
  readonly statePath: string;
  startRequested: boolean;
  failureRecorded: boolean;
}

/** The error-record codes for the source-resolution lines, by their `source <verb>` prefix. */
const SOURCE_DIAGNOSTIC_CODES: ReadonlyArray<readonly [prefix: string, code: string]> = [
  ['source refused ', 'source-refused'],
  ['source invalid ', 'source-invalid'],
  ['source id mismatch ', 'source-id-mismatch'],
  ['source load failed ', 'source-load-failed'],
  ['source loaded ', 'source-loaded'],
  ['source resolve failed ', 'source-resolve-failed'],
  ['source skipped ', 'source-skipped']
];

function sourceDiagnosticCode(line: string): string {
  const kind = SOURCE_DIAGNOSTIC_CODES.find(([prefix]) => line.startsWith(prefix));
  return kind?.[1] ?? 'source-diagnostic';
}

/** The recorded `scanEnv` of a boundary event: the transcript-root variables this source's scanner reads, set ones only. */
function scanEnvFor(source: string): Record<string, string> {
  const scanEnv: Record<string, string> = {};
  for (const name of BUILTIN_SOURCE_PLUGINS[source]?.scanEnv ?? []) {
    const value = process.env[name];
    if (value !== undefined) {
      scanEnv[name] = value;
    }
  }
  return scanEnv;
}

/** Write one record; a failed write records the failure once, best-effort, and loses the event (3.10). */
async function record(production: HookProduction, body: RecordBody): Promise<void> {
  try {
    const outcome = await produceRecord(production.statePath, body);
    if (outcome.status === 'recorded' && outcome.startWorker) {
      production.startRequested = true;
    }
  } catch (error) {
    if (!production.failureRecorded) {
      production.failureRecorded = true;
      await recordHookFailure(`hook failed: ${errorMessage(error)}`);
    }
  }
}

async function recordResolvedHook(
  production: HookProduction,
  options: { source: string; event: string | undefined; payload: unknown }
): Promise<void> {
  const { source, payload } = options;
  const config = await loadConfig();
  const diagnostics: SourceDiagnostics = [];
  const context = await resolveHookContextForSource(source, payload, config, { diagnostics });
  const event = options.event ?? context.event ?? 'Heartbeat';

  // The resolution lines precede the record, as the log lines they replace were written first (3.11).
  for (const line of diagnostics) {
    await record(production, { kind: 'error', code: sourceDiagnosticCode(line), message: line });
  }

  const sessionId = context.sessionId;
  if (!sessionId) {
    await record(production, {
      kind: 'skip',
      code: 'missing-session-id',
      source,
      nativeEvent: event,
      payloadKeys: describePayloadKeys(payload)
    });
    return;
  }

  const body: Extract<RecordBody, { kind: 'event' }> = {
    kind: 'event',
    source,
    event,
    sessionId,
    payloadKeys: describePayloadKeys(payload)
  };
  if (context.project !== undefined) {
    body.project = context.project;
  }
  const usage = usageEventFromPayload(source, payload, Date.now());
  if (usage) {
    // The record's usage keeps the fields of the built event; a later release's loose schema adds any it writes.
    body.usage = usage as RecordUsage;
  }
  if (isSessionBoundaryEvent(event)) {
    body.scanEnv = scanEnvFor(source);
  }
  await record(production, body);
}

async function runAgentHook(args: string[], production: HookProduction): Promise<void> {
  const agentId = optionValue(args, '--agent');
  if (agentId === undefined || agentId.startsWith('--')) {
    throw new Error('hook --agent requires a kit agent id');
  }
  const payload = await readStdinJson();
  const interpreted = interpretAgentHook(agentId, payload, process.env);
  if (interpreted.kind === 'skip') {
    // A skipped interpretation resolves no source, as the run that logged the reason resolved none.
    await record(production, {
      kind: 'skip',
      code: interpreted.code,
      ...(interpreted.code === 'ignored-event' ? { source: interpreted.source } : {}),
      ...(interpreted.code === 'no-presence-source' ? { agent: interpreted.agent } : {}),
      nativeEvent: interpreted.nativeEvent,
      payloadKeys: describePayloadKeys(payload)
    });
    return;
  }
  await recordResolvedHook(production, { source: interpreted.source, event: interpreted.event, payload });
}

async function runSourceHook(args: string[], production: HookProduction): Promise<void> {
  const source = optionValue(args, '--source') ?? 'codex';
  const payload = await readStdinJson();
  await recordResolvedHook(production, { source, event: optionValue(args, '--event'), payload });
}

export async function hook(args: string[]): Promise<void> {
  const silent = hasFlag(args, '--silent');
  const production: HookProduction = { statePath: getStatePath(), startRequested: false, failureRecorded: false };
  try {
    if (args.includes('--agent')) {
      await runAgentHook(args, production);
    } else {
      await runSourceHook(args, production);
    }
    if (production.startRequested) {
      startWorker();
    }
  } catch (error) {
    await recordHookFailure(`hook failed: ${errorMessage(error)}`);
  }

  writeHookOutput(silent);
}
