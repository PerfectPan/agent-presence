import { describe, expect, it } from 'vitest';
import { resolvePricing, resolveRecordCost } from '../src/usage/index.js';
import type { UsageRecord } from '../src/usage/index.js';

function record(partial: Partial<UsageRecord>): UsageRecord {
  return {
    source: 'claude',
    model: 'claude-opus-4-8',
    timestamp: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    costUsd: null,
    ...partial
  };
}

describe('resolvePricing', () => {
  it('matches the longest substring key', () => {
    // Exact supported-model snapshot keys beat broader fallback aliases.
    expect(resolvePricing('claude-opus-4-8')?.input).toBe(5);
    expect(resolvePricing('claude-sonnet-4-6')?.input).toBe(3);
    // gpt-5.5 is present in the LiteLLM snapshot and must beat the broader gpt-5 fallback.
    expect(resolvePricing('gpt-5.5')?.input).toBe(5);
    expect(resolvePricing('gpt-5.5')?.output).toBe(30);
  });

  it('returns null for unknown models', () => {
    expect(resolvePricing('some-unknown-model')).toBeNull();
  });

  it('applies overrides over defaults', () => {
    const pricing = resolvePricing('claude-opus-4-8', { opus: { input: 99 } });
    expect(pricing?.input).toBe(99);
    // unspecified fields fall back to the matched fallback alias
    expect(pricing?.output).toBe(75);
  });

  it('applies overrides over the LiteLLM snapshot', () => {
    const pricing = resolvePricing('gpt-5.5', { 'gpt-5.5': { input: 7 } });
    expect(pricing).toMatchObject({ input: 7, output: 30, cacheWrite: 5, cacheRead: 0.5 });
  });

  it('prices supported LiteLLM snapshot models without per-machine overrides', () => {
    expect(resolvePricing('claude-fable-5')).toEqual({
      input: 10,
      output: 50,
      cacheWrite: 12.5,
      cacheWrite1h: 20,
      cacheRead: 1
    });
    expect(resolvePricing('DeepSeek-V4-Pro')).toEqual({ input: 0.435, output: 0.87, cacheWrite: 0, cacheRead: 0.003625 });
    expect(resolvePricing('Gemini-3-Flash-Preview')).toEqual({ input: 0.5, output: 3, cacheWrite: 0.5, cacheRead: 0.05 });
  });

  it('uses exact LiteLLM prices for the current Codex and Claude model ids', () => {
    expect(resolvePricing('gpt-5.6-sol')).toMatchObject({
      input: 5,
      output: 30,
      cacheWrite: 6.25,
      cacheRead: 0.5,
      longContextThreshold: 272_000,
      longContextInput: 10,
      longContextOutput: 45,
      longContextCacheWrite: 12.5,
      longContextCacheRead: 1,
      fastMultiplier: 2
    });
    expect(resolvePricing('claude-sonnet-5')).toMatchObject({
      input: 2,
      output: 10,
      cacheWrite: 2.5,
      cacheRead: 0.2
    });
  });
});

describe('resolveRecordCost', () => {
  it('uses the recorded cost when present (Pi display mode), even when 0', () => {
    expect(resolveRecordCost(record({ source: 'pi', model: 'glm-5.1', costUsd: 0 }))).toBe(0);
    expect(resolveRecordCost(record({ source: 'pi', model: 'glm-5.1', costUsd: 1.23 }))).toBe(1.23);
  });

  it('computes cost from the pricing table when none is recorded', () => {
    const cost = resolveRecordCost(
      record({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 })
    );
    // claude-opus-4-8 from the LiteLLM snapshot: 5 input + 25 output + 0.5 cacheRead per MTok
    expect(cost).toBeCloseTo(5 + 25 + 0.5, 5);
  });

  it('prices Claude one-hour cache writes at their dedicated rate', () => {
    const cost = resolveRecordCost({
      ...record({ model: 'claude-sonnet-5', cacheWriteTokens: 1_000_000 }),
      cacheWrite1hTokens: 1_000_000
    });

    expect(cost).toBeCloseTo(4, 6);
  });

  it('applies the transcript billing-tier multiplier after bucket pricing', () => {
    const cost = resolveRecordCost({
      ...record({
        model: 'gpt-5.6-sol',
        inputTokens: 100_000,
        outputTokens: 100_000,
        cacheReadTokens: 100_000
      }),
      pricingMultiplier: 2
    });

    expect(cost).toBeCloseTo((0.5 + 3 + 0.05) * 2, 6);
  });

  it('uses the whole-request long-context tier above 272K Codex input tokens', () => {
    const cost = resolveRecordCost({
      ...record({
        model: 'gpt-5.6-sol',
        inputTokens: 200_001,
        cacheReadTokens: 72_000,
        outputTokens: 1_000
      }),
      pricingMultiplier: 2
    });

    // ccusage/OpenAI long-context rates are $10 input, $45 output, and $1 cached
    // input per MTok before the configured fast-tier multiplier.
    expect(cost).toBeCloseTo(4.23402, 8);

    const boundaryCost = resolveRecordCost({
      ...record({
        model: 'gpt-5.6-sol',
        inputTokens: 200_000,
        cacheReadTokens: 72_000,
        outputTokens: 1_000
      }),
      pricingMultiplier: 2
    });
    expect(boundaryCost).toBeCloseTo(2.132, 8);
  });

  it('returns null when the model is unpriced', () => {
    expect(resolveRecordCost(record({ model: 'mystery-model', inputTokens: 1_000_000 }))).toBeNull();
  });
});
