import { describe, expect, it } from 'vitest';
import { LGaryYangProvider } from '../src/providers/l-garyyang.js';
import { createProvider, registeredProviderIds } from '../src/providers/registry.js';
import {
  assertSupportsLogin,
  assertSupportsRemoteInfo,
  assertSupportsSignatureUrl,
  assertSupportsSlotUpdate,
  type PresenceProvider
} from '../src/providers/types.js';

describe('provider registry', () => {
  it('exposes feishu-signature as the default registered provider', () => {
    expect(registeredProviderIds()).toContain('feishu-signature');
  });

  it('returns an LGaryYangProvider instance for feishu-signature', () => {
    const provider = createProvider('feishu-signature', { baseUrl: 'https://l.garyyang.work' });
    expect(provider).toBeInstanceOf(LGaryYangProvider);
    expect(provider.id).toBe('feishu-signature');
  });

  it('passes the slot credential through to the provider', () => {
    const provider = createProvider('feishu-signature', {
      baseUrl: 'https://l.garyyang.work',
      credential: { token: 'tok', slotId: 'slot_test' }
    });
    const url = (provider as LGaryYangProvider).buildSignatureUrl({
      slotId: 'slot_test',
      previewBaseUrl: 'https://l.garyyang.work/'
    });
    expect(url).toContain('t2=');
  });

  it('throws when asked for an unregistered provider', () => {
    expect(() =>
      createProvider('unknown' as never, { baseUrl: 'https://example.test' })
    ).toThrow(/unsupported provider/);
  });
});

describe('provider capability asserts', () => {
  const fullProvider = createProvider('feishu-signature', { baseUrl: 'https://l.garyyang.work' });

  it('accepts the bundled provider for every capability it advertises', () => {
    expect(() => assertSupportsLogin(fullProvider)).not.toThrow();
    expect(() => assertSupportsSlotUpdate(fullProvider)).not.toThrow();
    expect(() => assertSupportsRemoteInfo(fullProvider)).not.toThrow();
    expect(() => assertSupportsSignatureUrl(fullProvider)).not.toThrow();
  });

  it('rejects providers missing the requested capability', () => {
    const minimal: PresenceProvider = { id: 'minimal' };
    expect(() => assertSupportsLogin(minimal)).toThrow(/does not support login/);
    expect(() => assertSupportsSlotUpdate(minimal)).toThrow(/does not support slot updates/);
    expect(() => assertSupportsRemoteInfo(minimal)).toThrow(/does not expose remote info/);
    expect(() => assertSupportsSignatureUrl(minimal)).toThrow(/does not build signature urls/);
  });
});
