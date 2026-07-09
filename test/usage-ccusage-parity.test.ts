import { describe, expect, it } from 'vitest';
import { resolveRecordCost } from '../src/usage/index.js';
import type { PricingOverrides, UsageRecord } from '../src/usage/index.js';

/**
 * ccusage-parity smoke test.
 *
 * agent-presence and ccusage must price a usage record the SAME way, so their
 * `usage` totals agree once a model is priced. This locks the per-bucket
 * formula, not any live ccusage number (ccusage is a Rust binary with its own
 * LiteLLM snapshot; in-house model prices drift). Verified against ccusage's
 * source (`rust/crates/ccusage/src/cost.rs` and the codex report path
 * `non_cached_input * input + cached * cache_read + output * output`):
 *
 *   cost = inputTokens      * input     (uncached input)
 *        + outputTokens     * output    (completion; reasoning folded in upstream)
 *        + cacheWriteTokens * cacheWrite (cache creation)
 *        + cacheReadTokens  * cacheRead  (cached read)     ) / 1e6
 *
 * Our scanners already split cached out of input (Codex/TraeX) and fold
 * reasoning into output, so the buckets line up with ccusage's inputs.
 */

function record(partial: Partial<UsageRecord>): UsageRecord {
  return {
    source: 'codex',
    model: 'gpt-5',
    timestamp: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    costUsd: null,
    ...partial
  };
}

// Fixed fixture prices (USD per 1M) — the assertion is about the FORMULA, so the
// numbers are arbitrary-but-distinct to catch a mis-wired bucket.
const PRICES: PricingOverrides = {
  'gpt-5': { input: 2, output: 8, cacheWrite: 2.5, cacheRead: 0.2 }
};

describe('ccusage cost parity (per-bucket formula)', () => {
  it('prices each bucket independently, matching ccusage calculate mode', () => {
    const cost = resolveRecordCost(
      record({
        inputTokens: 1_000_000, // uncached input
        outputTokens: 1_000_000,
        cacheWriteTokens: 1_000_000, // cache creation
        cacheReadTokens: 1_000_000
      }),
      PRICES
    );
    // 1M of each bucket at the fixture rates: 2 + 8 + 2.5 + 0.2
    expect(cost).toBeCloseTo(2 + 8 + 2.5 + 0.2, 6);
  });

  it('does NOT double-charge cached tokens against the input rate', () => {
    // A codex-style turn: total prompt 100k of which 80k cached. Our scanners
    // record inputTokens = 20k (uncached) and cacheReadTokens = 80k. ccusage
    // prices uncached@input + cached@cacheRead — NOT the full 100k @ input.
    const cost = resolveRecordCost(
      record({ inputTokens: 20_000, cacheReadTokens: 80_000, outputTokens: 1_000 }),
      PRICES
    );
    const expected = (20_000 * 2 + 80_000 * 0.2 + 1_000 * 8) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 9);
    // Sanity: charging the full 100k at the input rate would be materially higher.
    const wrongDoubleCount = (100_000 * 2 + 80_000 * 0.2 + 1_000 * 8) / 1_000_000;
    expect(cost).toBeLessThan(wrongDoubleCount);
  });

  it('trusts a transcript-provided cost as-is (pi/opencode), bypassing the table', () => {
    expect(resolveRecordCost(record({ source: 'pi', costUsd: 3.5 }), PRICES)).toBe(3.5);
    expect(resolveRecordCost(record({ source: 'opencode', costUsd: 0 }), PRICES)).toBe(0);
  });

  it('reports null (not a wrong number) for an unpriced in-house model', () => {
    // gpt-5.5 / fable-5 etc. are not in DEFAULT_PRICING; until an override is
    // added they must yield null, keeping token counts exact.
    expect(resolveRecordCost(record({ model: 'fable-5', inputTokens: 1_000_000 }))).toBeNull();
    // With an explicit override, the same record prices via the formula above.
    const priced = resolveRecordCost(record({ model: 'fable-5', inputTokens: 1_000_000 }), {
      'fable-5': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 }
    });
    expect(priced).toBeCloseTo(15, 6);
  });
});
