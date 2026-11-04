import { describe, expect, it } from 'vite-plus/test';
import { createProvider, registeredProviderIds } from './registry.js';

describe('provider registry', () => {
  it('registers both shipped providers', () => {
    expect(registeredProviderIds().sort()).toEqual(['feishu-signature', 'magic-builder']);
  });

  it('throws for an unknown provider id', () => {
    // @ts-expect-error intentionally passing an unregistered id
    expect(() => createProvider('does-not-exist', { config: {} })).toThrow('unsupported provider: does-not-exist');
  });
});
