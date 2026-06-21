import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { createProvider, registeredProviderIds } from '../src/providers/registry.js';
import {
  assertSupportsLogin,
  assertSupportsSignatureUrl,
  assertSupportsSlotUpdate,
  type PresenceProvider
} from '../src/providers/types.js';

describe('provider registry', () => {
  it('registers both shipped providers', () => {
    expect(registeredProviderIds().sort()).toEqual(['feishu-signature', 'magic-builder']);
  });

  it('throws for an unknown provider id', () => {
    // @ts-expect-error intentionally passing an unregistered id
    expect(() => createProvider('does-not-exist', { config: {} })).toThrow('unsupported provider: does-not-exist');
  });

  describe('feishu-signature', () => {
    it('exposes login, slot update, info, and signature-url capabilities but no remote preview', () => {
      const provider = createProvider('feishu-signature', { config: {} });
      expect(provider.id).toBe('feishu-signature');
      expect(provider.createQrCode).toBeTypeOf('function');
      expect(provider.getLoginStatus).toBeTypeOf('function');
      expect(provider.updateSlot).toBeTypeOf('function');
      expect(provider.getInfo).toBeTypeOf('function');
      expect(provider.buildSignatureUrl).toBeTypeOf('function');
      expect(provider.getRemotePreview).toBeUndefined();
    });

    it('builds a direct preview url from the configured slot id', () => {
      const config: AppConfig = { slot_id: 'slot_abc' };
      const url = createProvider('feishu-signature', { config }).buildSignatureUrl!();
      expect(url.startsWith('https://l.garyyang.work/?t2=')).toBe(true);
    });

    it('refuses to build a signature url without a slot id', () => {
      expect(() => createProvider('feishu-signature', { config: {} }).buildSignatureUrl!()).toThrow(
        'missing slot_id'
      );
    });
  });

  describe('magic-builder', () => {
    it('exposes a remote preview capability in addition to the slot capabilities', () => {
      const config: AppConfig = { providers: { 'magic-builder': { faasId: 'rec_1' } } };
      const provider = createProvider('magic-builder', { config });
      expect(provider.id).toBe('magic-builder');
      expect(provider.updateSlot).toBeTypeOf('function');
      expect(provider.getInfo).toBeTypeOf('function');
      expect(provider.getRemotePreview).toBeTypeOf('function');
    });

    it('builds the FaaS preview url from the stored record id', () => {
      const config: AppConfig = { providers: { 'magic-builder': { faasId: 'rec_1' } } };
      const url = createProvider('magic-builder', { config }).buildSignatureUrl!();
      expect(url).toBe('https://magic.solutionsuite.cn/r?fid=rec_1');
    });

    it('refuses to build a signature url before a FaaS is published', () => {
      expect(() => createProvider('magic-builder', { config: {} }).buildSignatureUrl!()).toThrow(
        'has no published FaaS yet'
      );
    });
  });

  describe('capability assertions', () => {
    const bare: PresenceProvider = { id: 'feishu-signature' };

    it('reports a missing login capability', () => {
      expect(() => assertSupportsLogin(bare)).toThrow('provider "feishu-signature" does not support login');
    });

    it('reports a missing slot-update capability', () => {
      expect(() => assertSupportsSlotUpdate(bare)).toThrow('provider "feishu-signature" does not support slot updates');
    });

    it('reports a missing signature-url capability', () => {
      expect(() => assertSupportsSignatureUrl(bare)).toThrow('provider "feishu-signature" does not build signature urls');
    });

    it('passes through a provider that has the capability', () => {
      const provider = createProvider('feishu-signature', { config: { slot_id: 'slot_abc' } });
      expect(() => assertSupportsLogin(provider)).not.toThrow();
      expect(() => assertSupportsSlotUpdate(provider)).not.toThrow();
      expect(() => assertSupportsSignatureUrl(provider)).not.toThrow();
    });
  });
});
