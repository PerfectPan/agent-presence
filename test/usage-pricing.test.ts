import { describe, expect, it } from 'vite-plus/test';
import { parseConfigFile } from '../src/config-schema.js';
import { parsePricingSnapshot } from '../src/usage/pricing.js';
import { resolvePricing, resolveRecordCost } from '../src/usage/index.js';
import type { PricingOverrides, UsageRecord } from '../src/usage/index.js';

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

  it('prefers the longest matching override key over a shorter one', () => {
    const pricing = resolvePricing('claude-opus-4-8-20260101', {
      opus: { input: 1 },
      'claude-opus-4-8': { input: 2 }
    });
    // the longer `claude-opus-4-8` override wins over the broad `opus` alias
    expect(pricing?.input).toBe(2);
    // its unset fields come from the same key's snapshot entry, not the alias
    expect(pricing?.output).toBe(25);
    expect(pricing?.cacheWrite1h).toBe(10);
  });

  it('lets an empty-string override key price every model ahead of the snapshot', () => {
    // Deliberate kit-lookup behavior, kept: the empty key is a substring of
    // every id and overrides win over the tables, so it acts as a catch-all.
    // The old walk's falsy-key check made the same config price nothing.
    const every: PricingOverrides = { '': { input: 2, output: 4, cacheWrite: 1, cacheRead: 0.5 } };
    expect(resolvePricing('totally-unknown-model', every)).toEqual({
      input: 2,
      output: 4,
      cacheWrite: 1,
      cacheRead: 0.5
    });
    expect(resolvePricing('gpt-5.5', every)).toEqual({ input: 2, output: 4, cacheWrite: 1, cacheRead: 0.5 });
  });

  it('gives an incomplete override of an untabulated key no price instead of guessing', () => {
    // no table or fallback entry shares `openrouter-3o`, so the partial
    // override cannot be completed and the model stays unpriced
    expect(resolvePricing('openrouter-3o', { 'openrouter-3o': { input: 1 } })).toBeNull();
  });

  it('applies overrides over the LiteLLM snapshot', () => {
    const pricing = resolvePricing('gpt-5.5', { 'gpt-5.5': { input: 7 } });
    expect(pricing).toEqual({ input: 7, output: 30, cacheWrite: 5, cacheRead: 0.5 });
  });

  it('prices supported LiteLLM snapshot models without per-machine overrides', () => {
    expect(resolvePricing('claude-fable-5')).toEqual({
      input: 10,
      output: 50,
      cacheWrite: 12.5,
      cacheWrite1h: 20,
      cacheRead: 1
    });
    expect(resolvePricing('DeepSeek-V4-Pro')).toEqual({
      input: 0.435,
      output: 0.87,
      cacheWrite: 0,
      cacheRead: 0.003625
    });
    expect(resolvePricing('Gemini-3-Flash-Preview')).toEqual({
      input: 0.5,
      output: 3,
      cacheWrite: 0.5,
      cacheRead: 0.05
    });
  });

  it('uses exact LiteLLM prices for the current Codex and Claude model ids', () => {
    expect(resolvePricing('gpt-5.6-sol')).toMatchObject({
      input: 5,
      output: 30,
      cacheWrite: 6.25,
      cacheRead: 0.5
    });
    expect(resolvePricing('claude-sonnet-5')).toMatchObject({
      input: 2,
      output: 10,
      cacheWrite: 2.5,
      cacheRead: 0.2
    });
  });
});

describe('parsePricingSnapshot', () => {
  it('parses the snapshot shape, dropping unknown root and entry keys', () => {
    expect(
      parsePricingSnapshot({
        _comment: 'generated',
        prices: { 'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, note: 'x', cacheRead: 0.5 } }
      })
    ).toEqual({ 'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } });
  });

  it('keeps an optional cacheWrite1h rate', () => {
    expect(
      parsePricingSnapshot({
        prices: { 'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.5 } }
      })
    ).toEqual({ 'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.5 } });
  });

  it('yields no prices for a wrong-typed entry rate, so the fallback table serves every lookup', () => {
    expect(
      parsePricingSnapshot({
        prices: {
          'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: '0.5' },
          'gpt-5': { input: 1.25, output: 10, cacheWrite: 1.25, cacheRead: 0.125 }
        }
      })
    ).toEqual({});
  });

  it('yields no prices for a non-object root, a missing prices map, or a wrong-typed entry', () => {
    expect(parsePricingSnapshot([1, 2, 3])).toEqual({});
    expect(parsePricingSnapshot('generated')).toEqual({});
    expect(parsePricingSnapshot({ _comment: 'generated' })).toEqual({});
    expect(parsePricingSnapshot({ prices: { 'gpt-5': 'cheap' } })).toEqual({});
    expect(parsePricingSnapshot({ prices: { 'gpt-5': null } })).toEqual({});
  });
});

describe('pricing overrides through the config loader', () => {
  it('prices a snapshot model from the snapshot when its override field is dropped', () => {
    // `input: "x"` is reported and dropped to absent; the empty override
    // entry completes from the snapshot's same-key entry instead of pricing
    // nothing (a kept `undefined` field would).
    const { config, issues } = parseConfigFile({ usage: { pricing: { 'gpt-5.5': { input: 'x' } } } });
    expect(issues).toEqual([{ path: 'usage.pricing.gpt-5.5.input', reason: 'expected a number' }]);
    expect(resolvePricing('gpt-5.5', config.usage?.pricing)).toEqual({
      input: 5,
      output: 30,
      cacheWrite: 5,
      cacheRead: 0.5
    });
  });

  it('prices an override field written as a numeric string at its number', () => {
    const { config, issues } = parseConfigFile({ usage: { pricing: { 'gpt-5.5': { input: '7' } } } });
    expect(issues).toEqual([]);
    expect(resolvePricing('gpt-5.5', config.usage?.pricing)).toEqual({
      input: 7,
      output: 30,
      cacheWrite: 5,
      cacheRead: 0.5
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
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000
      }),
      pricingMultiplier: 2
    });

    expect(cost).toBeCloseTo((5 + 30 + 0.5) * 2, 6);
  });

  it('returns null when the model is unpriced', () => {
    expect(resolveRecordCost(record({ model: 'mystery-model', inputTokens: 1_000_000 }))).toBeNull();
  });
});
