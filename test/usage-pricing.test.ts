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
    expect(resolvePricing('claude-opus-4-8')?.input).toBe(15);
    expect(resolvePricing('claude-sonnet-4-6')?.input).toBe(3);
    expect(resolvePricing('gpt-5.5')?.input).toBe(1.25);
  });

  it('returns null for unknown models', () => {
    expect(resolvePricing('some-unknown-model')).toBeNull();
  });

  it('applies overrides over defaults', () => {
    const pricing = resolvePricing('claude-opus-4-8', { opus: { input: 99 } });
    expect(pricing?.input).toBe(99);
    // unspecified fields fall back to the default opus rates
    expect(pricing?.output).toBe(75);
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
    // opus: 15 input + 75 output + 1.5 cacheRead per MTok
    expect(cost).toBeCloseTo(15 + 75 + 1.5, 5);
  });

  it('returns null when the model is unpriced', () => {
    expect(resolveRecordCost(record({ model: 'mystery-model', inputTokens: 1_000_000 }))).toBeNull();
  });
});
