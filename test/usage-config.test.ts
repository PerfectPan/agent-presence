import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usagePricingOverrides, usageShowInSignature, usageSignatureWindowDays } from '../src/config.js';

const ENV_KEYS = ['AGENT_PRESENCE_USAGE_IN_SIGNATURE', 'AGENT_PRESENCE_USAGE_WINDOW_DAYS'];

describe('usage config accessors', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  it('defaults: disabled, 1-day window, no overrides', () => {
    expect(usageShowInSignature({})).toBe(false);
    expect(usageSignatureWindowDays({})).toBe(1);
    expect(usagePricingOverrides({})).toEqual({});
  });

  it('reads config values', () => {
    expect(usageShowInSignature({ usage: { showInSignature: true } })).toBe(true);
    expect(usageSignatureWindowDays({ usage: { signatureWindowDays: 7 } })).toBe(7);
    expect(usagePricingOverrides({ usage: { pricing: { opus: { input: 9 } } } })).toEqual({ opus: { input: 9 } });
  });

  it('env overrides config', () => {
    process.env.AGENT_PRESENCE_USAGE_IN_SIGNATURE = '1';
    process.env.AGENT_PRESENCE_USAGE_WINDOW_DAYS = '7';
    expect(usageShowInSignature({ usage: { showInSignature: false } })).toBe(true);
    expect(usageSignatureWindowDays({ usage: { signatureWindowDays: 1 } })).toBe(7);
  });
});
