import * as z from 'zod/mini';
// Imported by name: called as `z.catch(...)`, the promise lint rule mistakes it for `Promise.prototype.catch`.
import { catch as catchInvalid } from 'zod/mini';
import { SCAN_ENV } from '../cli/hook-context.js';

// Only appliers (the worker and the commands that take over) and the state store import this module; the hook graph
// must not reach it, because loading zod costs the hook about 22 ms (Plan 0003 3.2, test/hook-graph.test.ts).

const nonNegativeInteger = z.int().check(z.nonnegative());
const nonEmptyString = z.string().check(z.minLength(1));
const tokenCount = z.number().check(z.nonnegative());

// Objects that end up in the state's owed work are loose: a later release may add fields to them, and every release
// keeps the fields it does not know (Plan 0003 3.5). A record's own copies are loose too, so those fields reach the
// owed entry, and through it the dsh usage line, unchanged.

/** A dsh usage event as `usageEventFromPayload` builds it. */
const usageSchema = z.looseObject({
  source: z.string(),
  model: z.string(),
  timestamp: z.number(),
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cacheWriteTokens: tokenCount,
  cacheReadTokens: tokenCount
});

/** The environment values that locate a source's transcripts, by variable name. */
const scanEnvSchema = z.looseObject({
  [SCAN_ENV.claudeConfigDir]: z.optional(z.string()),
  [SCAN_ENV.geminiCliHome]: z.optional(z.string()),
  [SCAN_ENV.xdgDataHome]: z.optional(z.string())
});

/** Parses `v` alone, so an applier leaves a record of a newer release in place without parsing the rest. */
const versionSchema = z.object({ v: nonNegativeInteger });

const recordHeader = {
  v: nonNegativeInteger,
  /** The file name without its extension. */
  id: nonEmptyString,
  /** Wall-clock milliseconds when the producer recorded it. */
  recordedAt: nonNegativeInteger,
  /** What `<state>.epoch` held when the producer read it before its tombstone check. */
  epoch: nonNegativeInteger
};

const eventRecordSchema = z.object({
  ...recordHeader,
  kind: z.literal('event'),
  source: nonEmptyString,
  /** Presence's internal event name. */
  event: nonEmptyString,
  sessionId: nonEmptyString,
  project: z.optional(z.string()),
  subagent: z.optional(z.object({ id: z.optional(z.string()), type: z.optional(z.string()) })),
  /** dsh only. */
  usage: z.optional(usageSchema),
  /** Boundary events only. */
  scanEnv: z.optional(scanEnvSchema),
  payloadKeys: z.array(z.string())
});

const skipRecordSchema = z
  .object({
    ...recordHeader,
    kind: z.literal('skip'),
    code: z.enum(['missing-session-id', 'no-presence-source', 'ignored-event']),
    source: z.optional(nonEmptyString),
    agent: z.optional(nonEmptyString),
    nativeEvent: z.string(),
    payloadKeys: z.array(z.string())
  })
  .check(z.refine((record) => record.source !== undefined || record.agent !== undefined, 'names no source or agent'));

const errorRecordSchema = z.object({
  ...recordHeader,
  kind: z.literal('error'),
  code: nonEmptyString,
  source: z.optional(nonEmptyString),
  /** Holds no payload value. */
  message: z.string()
});

const recordSchema = z.discriminatedUnion('kind', [eventRecordSchema, skipRecordSchema, errorRecordSchema]);

export type EventRecord = z.infer<typeof eventRecordSchema>;
export type SkipRecord = z.infer<typeof skipRecordSchema>;
export type ErrorRecord = z.infer<typeof errorRecordSchema>;
export type QueueRecord = z.infer<typeof recordSchema>;
export type RecordUsage = z.infer<typeof usageSchema>;
export type ScanEnv = z.infer<typeof scanEnvSchema>;

/** The record version, or `undefined` when the record has no non-negative integer `v`. */
export function readRecordVersion(raw: unknown): number | undefined {
  const parsed = versionSchema.safeParse(raw);
  return parsed.success ? parsed.data.v : undefined;
}

/** A failure names the fields and issue codes only, never a value, so it can be logged. */
export function parseQueueRecord(raw: unknown): { ok: true; record: QueueRecord } | { ok: false; reason: string } {
  const parsed = recordSchema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, record: parsed.data };
  }
  const reason = parsed.error.issues
    .map((issue) => `${issue.path.map(String).join('.') || 'record'}: ${issue.code}`)
    .join(', ');
  return { ok: false, reason };
}

/** A list whose items that do not parse are dropped, so one bad item loses only itself. */
function itemsThatParse<T extends z.ZodMiniType>(item: T) {
  return z.pipe(
    z.array(z.unknown()),
    z.transform((items) =>
      items.flatMap((candidate) => {
        const parsed = item.safeParse(candidate);
        return parsed.success ? [parsed.data] : [];
      })
    )
  );
}

const dshUsageEntrySchema = z.looseObject({
  /** The id of the record the usage came from; the usage line carries it. */
  id: nonEmptyString,
  usage: usageSchema
});

const usageRefreshEntrySchema = z.looseObject({
  source: nonEmptyString,
  scanEnv: scanEnvSchema,
  /** The latest boundary's recorded time. */
  boundaryAt: z.number(),
  /** Increases whenever a newer boundary updates the entry. */
  generation: nonNegativeInteger
});

const queueOwedSchema = z.looseObject({
  dshUsage: catchInvalid(z.optional(itemsThatParse(dshUsageEntrySchema)), undefined),
  usageRefresh: catchInvalid(z.optional(itemsThatParse(usageRefreshEntrySchema)), undefined),
  renderedSync: catchInvalid(z.optional(z.boolean()), undefined)
});

const queueAppliedSchema = itemsThatParse(nonEmptyString);

export type DshUsageEntry = z.infer<typeof dshUsageEntrySchema>;
export type UsageRefreshEntry = z.infer<typeof usageRefreshEntrySchema>;
/**
 * Follow-up work that applied records owe. Every level is loose: keys, entry fields, and fields of an entry's `usage`
 * and `scanEnv` that this release does not know load as they are and are saved back. A release changes a known entry
 * in place and never builds a new object for it, so the entry keeps those fields (Plan 0003 3.5).
 */
export type QueueOwed = z.infer<typeof queueOwedSchema>;

/** The ids of applied records, or `undefined` when the value is not a list; items that are not ids are dropped. */
export function parseQueueApplied(raw: unknown): string[] | undefined {
  const parsed = queueAppliedSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The owed work, or `undefined` when the value is not an object. A known key whose value does not parse loads as
 * absent, and a list entry that does not parse is dropped.
 */
export function parseQueueOwed(raw: unknown): QueueOwed | undefined {
  const parsed = queueOwedSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
