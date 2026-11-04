import { litellmPrices } from '@rivus/agent-kit/cost/prices';
import { describe, expect, it } from 'vite-plus/test';
import { parseConfigFile } from '../src/config-schema.js';
import { resolvePricing } from '../src/usage/index.js';

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
