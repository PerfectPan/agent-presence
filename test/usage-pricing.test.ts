import { litellmPrices } from '@rivus/agent-kit/cost/prices';
import { describe, expect, it } from 'vite-plus/test';
import { parseConfigFile } from '../src/config-schema.js';
import { resolvePricing } from '../src/usage/index.js';
import type { PricingOverrides } from '../src/usage/index.js';

describe('resolvePricing', () => {
  it.each([
    'claude-opus-4-8',
    'claude-sonnet-4-6',
    'claude-sonnet-5',
    'claude-fable-5',
    'gpt-5',
    'gpt-5.5',
    'gpt-5.6-sol',
    'deepseek-v4-pro',
    'gemini-3-flash-preview',
    'glm-5.1'
  ])('prices %s at its LiteLLM table price', (model) => {
    expect(resolvePricing(model)).toEqual(litellmPrices[model]);
  });

  it('matches table keys regardless of case', () => {
    expect(resolvePricing('DeepSeek-V4-Pro')).toEqual(litellmPrices['deepseek-v4-pro']);
    expect(resolvePricing('Gemini-3-Flash-Preview')).toEqual(litellmPrices['gemini-3-flash-preview']);
  });

  it('prices a dated or provider-prefixed id at its model table price', () => {
    expect(resolvePricing('claude-opus-4-8-20260101')).toEqual(litellmPrices['claude-opus-4-8']);
    expect(resolvePricing('gpt-5.6-sol-2026-07-09')).toEqual(litellmPrices['gpt-5.6-sol']);
    expect(resolvePricing('anthropic/claude-sonnet-5')).toEqual(litellmPrices['claude-sonnet-5']);
  });

  it('prices a suffixed variant the table does not name at its model table price', () => {
    expect(resolvePricing('claude-opus-4-8-thinking')).toEqual(litellmPrices['claude-opus-4-8']);
    expect(resolvePricing('claude-opus-4-8[1m]')).toEqual(litellmPrices['claude-opus-4-8']);
    expect(resolvePricing('us.anthropic.claude-opus-4-8-v1:0')).toEqual(litellmPrices['claude-opus-4-8']);
    expect(resolvePricing('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toEqual(litellmPrices['claude-sonnet-4-5']);
    expect(resolvePricing('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toEqual(litellmPrices['claude-haiku-4-5']);
    expect(resolvePricing('gpt-5.4-codex')).toEqual(litellmPrices['gpt-5.4']);
    expect(resolvePricing('gpt-5.5-codex')).toEqual(litellmPrices['gpt-5.5']);
    expect(resolvePricing('gpt-5.6-sol-high')).toEqual(litellmPrices['gpt-5.6-sol']);
    expect(resolvePricing('deepseek-v4-pro-thinking')).toEqual(litellmPrices['deepseek-v4-pro']);
  });

  it.each(
    ['claude-sonnet-5', 'claude-fable-5', 'claude-haiku-5-5', 'claude-opus-5-5'].flatMap((model) =>
      [`${model}-thinking`, `${model}[1m]`, `us.anthropic.${model}-v1:0`].map((variant) => [variant, model])
    )
  )('prices the Claude variant %s at the table price of %s', (variant, model) => {
    expect(resolvePricing(variant)).toEqual(litellmPrices[model]);
  });

  it.each([
    ['gpt-5.4-mini-high', 'gpt-5.4-mini'],
    ['gpt-5.5-pro-high', 'gpt-5.5-pro'],
    ['gpt-5.6-high', 'gpt-5.6'],
    ['gpt-5.6-terra-high', 'gpt-5.6-terra'],
    ['gpt-5.6-luna-high', 'gpt-5.6-luna']
  ])('prices %s at the table price of %s, the longest model its id contains', (variant, model) => {
    expect(resolvePricing(variant)).toEqual(litellmPrices[model]);
  });

  it('charges a Claude family alias the table price of the model it stands for', () => {
    // ids that contain none of the table's models
    expect(resolvePricing('claude-opus-4-9')).toEqual(litellmPrices['claude-opus-4-8']);
    expect(resolvePricing('claude-sonnet-4-7')).toEqual(litellmPrices['claude-sonnet-4-6']);
    expect(resolvePricing('claude-haiku-4-6')).toEqual(litellmPrices['claude-haiku-4-5']);
  });

  it('prices models the table does not name at their last list prices', () => {
    const opus4 = { input: 15, output: 75, cacheWrite: 18.75, cacheWrite1h: 30, cacheRead: 1.5 };
    // each retired key is longer than the `opus` family alias, which charges a third of these prices
    expect(resolvePricing('claude-opus-4-1')).toEqual(opus4);
    expect(resolvePricing('us.anthropic.claude-opus-4-1-20250805-v1:0')).toEqual(opus4);
    expect(resolvePricing('claude-opus-4-20250514')).toEqual(opus4);
    expect(resolvePricing('us.anthropic.claude-opus-4-20250514-v1:0')).toEqual(opus4);
    expect(resolvePricing('claude-3-opus-20240229')).toEqual(opus4);
    expect(resolvePricing('gemini-3-pro-preview')).toEqual({ input: 2, output: 12, cacheWrite: 2, cacheRead: 0.2 });
  });

  it('returns null for unknown models', () => {
    expect(resolvePricing('some-unknown-model')).toBeNull();
    // neither a GPT-5 family alias nor bare `gpt-5` prices an unlisted version as another
    expect(resolvePricing('gpt-5.7')).toBeNull();
    expect(resolvePricing('gpt-5.7-codex')).toBeNull();
  });

  it('applies overrides over defaults', () => {
    const pricing = resolvePricing('claude-opus-4-8', { opus: { input: 99 } });
    expect(pricing?.input).toBe(99);
    // unspecified fields come from the id's own price, not the `opus` alias
    expect(pricing?.output).toBe(25);
  });

  it('prefers the longest matching override key over a shorter one', () => {
    const pricing = resolvePricing('claude-opus-4-8-20260101', {
      opus: { input: 1 },
      'claude-opus-4-8': { input: 2 }
    });
    // the longer `claude-opus-4-8` override wins over the broad `opus` key;
    // its unset fields come from the id's own table price
    expect(pricing).toEqual({ ...litellmPrices['claude-opus-4-8'], input: 2 });
  });

  it('lets an empty-string override key price every model ahead of the table', () => {
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

  it('applies overrides over the LiteLLM table', () => {
    expect(resolvePricing('gpt-5.5', { 'gpt-5.5': { input: 7 } })).toEqual({ ...litellmPrices['gpt-5.5'], input: 7 });
  });
});

describe('pricing overrides through the config loader', () => {
  it('prices a table model from the table when its override field is dropped', () => {
    // `input: "x"` is reported and dropped to absent; the empty override
    // entry completes from the model's table price instead of pricing
    // nothing (a kept `undefined` field would).
    const { config, issues } = parseConfigFile({ usage: { pricing: { 'gpt-5.5': { input: 'x' } } } });
    expect(issues).toEqual([{ path: 'usage.pricing.gpt-5.5.input', reason: 'expected a number' }]);
    expect(resolvePricing('gpt-5.5', config.usage?.pricing)).toEqual(litellmPrices['gpt-5.5']);
  });

  it('prices an override field written as a numeric string at its number', () => {
    const { config, issues } = parseConfigFile({ usage: { pricing: { 'gpt-5.5': { input: '7' } } } });
    expect(issues).toEqual([]);
    expect(resolvePricing('gpt-5.5', config.usage?.pricing)).toEqual({ ...litellmPrices['gpt-5.5'], input: 7 });
  });
});
