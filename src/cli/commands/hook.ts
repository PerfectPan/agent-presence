import { getStatePath, loadConfig } from '../../config.js';
import { produceRecord, type RecordBody } from '../../queue/produce.js';
import { isSessionBoundaryEvent } from '../../state.js';
import { usageEventFromPayload } from '../../usage-events.js';
import { hasFlag, optionValue } from '../args.js';
import { errorMessage } from '../errors.js';
import { describePayloadKeys } from '../hook-diagnostics.js';
import { interpretAgentHook } from '../hook-interpret.js';
import { recordHookFailure, startHookWorker, writeHookOutput } from '../hook-output.js';
import { BUILTIN_SOURCE_PLUGINS } from '../hook-context.js';
import { readStdinJson } from '../io.js';
import { resolveHookContextForSource, type SourceDiagnostics } from '../../sources.js';

// The hook is the queue's producer (Plan 0003 3.3): it interprets the payload in process, writes one record, and
// starts a worker when no process of this release or a newer one holds the worker lock. It takes no lock, writes no
// log line (3.11) and no stop request, and prints its output and exits 0 in every case: a failed read, write or start
// loses the event (3.10). The direct application path stays in `src/cli/hook-apply.ts` until Q2 deletes it; the
// event-table test uses it as the oracle.

/** The queue writes of one hook run: whether a worker is wanted, and whether the run already recorded its failure. */
interface HookProduction {
  /** Set inside the run's try: reading it can fail (no HOME, no passwd entry), and the run still prints its output. */
  statePath: string;
  startRequested: boolean;
  failureRecorded: boolean;
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
      if (await recordHookFailure(`hook failed: ${errorMessage(error)}`)) {
        production.startRequested = true;
      }
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

  // The resolution lines become error records like the run's main record below (3.11); with the same recorded time,
  // the applier's file-name order decides when they are applied.
  for (const diagnostic of diagnostics) {
    await record(production, {
      kind: 'error',
      code: diagnostic.code,
      source: diagnostic.source,
      message: diagnostic.message
    });
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
    // A fresh literal fits the record's usage, which keeps the fields a later release writes; the named UsageEvent
    // interface would not carry the index signature.
    body.usage = { ...usage };
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
  const production: HookProduction = { statePath: '', startRequested: false, failureRecorded: false };
  let startRequested = false;
  try {
    production.statePath = getStatePath();
    if (args.includes('--agent')) {
      await runAgentHook(args, production);
    } else {
      await runSourceHook(args, production);
    }
    startRequested = production.startRequested;
  } catch (error) {
    // The records so far asked for a worker too, and one `hook failed` record per run at most: a failed write has
    // already recorded it.
    startRequested = production.startRequested;
    if (!production.failureRecorded && (await recordHookFailure(`hook failed: ${errorMessage(error)}`))) {
      startRequested = true;
    }
  }

  if (startRequested) {
    try {
      startHookWorker();
    } catch (error) {
      // A failed start loses the records to the next producer (3.10); the run still prints its output.
      if (!production.failureRecorded) {
        await recordHookFailure(`hook failed: ${errorMessage(error)}`);
      }
    }
  }

  writeHookOutput(silent);
}
