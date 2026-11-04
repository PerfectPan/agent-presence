import { describe, expect, it } from 'vite-plus/test';
import {
  assertSupportsLogin,
  assertSupportsPublish,
  assertSupportsSignatureUrl,
  type PresenceProvider
} from './types.js';

describe('provider registry', () => {
  describe('capability assertions', () => {
    const bare: PresenceProvider = { id: 'feishu-signature' };

    it('reports a missing login capability', () => {
      expect(() => assertSupportsLogin(bare)).toThrow('provider "feishu-signature" does not support login');
    });

    it('reports a missing publish capability', () => {
      expect(() => assertSupportsPublish(bare)).toThrow(
        'provider "feishu-signature" does not support publishing values'
      );
    });

    it('reports a missing signature-url capability', () => {
      expect(() => assertSupportsSignatureUrl(bare)).toThrow(
        'provider "feishu-signature" does not build signature urls'
      );
    });
  });
});
