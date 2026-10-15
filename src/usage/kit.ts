import type { UsageRecord as KitUsageRecord } from '@rivus/agent-kit/transcript/usage';

import type { UsageRecord } from './types.js';

/**
 * The kit agent whose decoder scans each built-in source, named in one place:
 * the source table keeps presence ids, the kit's `scanUsage` keeps kit agent
 * ids, and this table maps between them for the batched window scan.
 */
export const KIT_AGENT_BY_SOURCE: Readonly<Record<string, string>> = {
  claude: 'claude-code',
  codex: 'codex',
  gemini: 'gemini-cli',
  grok: 'grok',
  opencode: 'opencode',
  pi: 'pi'
};

/**
 * Turn a scanner record (the shape `SourcePlugin.scanUsage` hands out: input
 * excludes the cache, output excludes reasoning) into a kit record, so dsh and
 * custom handler sources are priced and summarized by the same kit rules as the
 * kit-decoded sources. The kit record's `inputTokens` adds the cache counts
 * back; a logged cost stays logged, an absent one is derived from the table.
 * `sessionId` and `source` only identify a transcript location, which a scanned
 * record never carries, so they stay blank.
 */
export function toKitRecord(record: UsageRecord, agent: string): KitUsageRecord {
  return {
    agent,
    sessionId: '',
    granularity: 'request',
    timestamp: record.timestamp,
    usage: {
      inputTokens: record.inputTokens + record.cacheWriteTokens + record.cacheReadTokens,
      outputTokens: record.outputTokens,
      cacheWriteTokens: record.cacheWriteTokens,
      cacheReadTokens: record.cacheReadTokens,
      ...(record.cacheWrite1hTokens === undefined ? {} : { cacheWrite1hTokens: record.cacheWrite1hTokens })
    },
    ...(record.model.length > 0 ? { model: record.model } : {}),
    ...(record.pricingMultiplier === undefined ? {} : { pricingMultiplier: record.pricingMultiplier }),
    ...(record.costUsd === null ? {} : { costUsd: record.costUsd, costSource: 'agent' as const }),
    source: { file: '', offset: 0, length: 0, line: 0 }
  };
}
