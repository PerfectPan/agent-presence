import { afterEach, describe, expect, it, vi } from 'vitest';
import { base62Encode, LGaryYangProvider } from '../src/providers/l-garyyang.js';

describe('l.garyyang signature URL', () => {
  it('encodes the slot helper in t2 instead of exposing slotId as an ignored query param', () => {
    const provider = new LGaryYangProvider('https://l.garyyang.work');
    const url = new URL(
      provider.buildSignatureUrl({
        previewBaseUrl: 'https://l.garyyang.work/',
        slotId: 'slot_test',
        targetUrl: 'https://example.com',
        imageKey: 'img_test'
      })
    );

    expect(url.searchParams.get('slotId')).toBeNull();
    expect(url.searchParams.get('t2')).toBe(base62Encode('{{slot id="slot_test"}}'));
    expect(url.searchParams.get('u')).toBe('https://example.com');
    expect(url.searchParams.get('k')).toBe('img_test');
  });
});

describe('l.garyyang login status', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts current confirmed login responses with credential and user slot ids', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({
        status: 'confirmed',
        credential: 'cred_test',
        user: {
          slotIds: ['slot_existing', 'slot_new']
        }
      })))
    );

    const provider = new LGaryYangProvider('https://l.garyyang.work');

    await expect(provider.getLoginStatus('cslot_test')).resolves.toEqual({
      status: 'confirmed',
      token: 'cred_test',
      slotId: 'slot_existing'
    });
  });

  it('keeps expired login status visible to the cli', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'expired' }))));

    const provider = new LGaryYangProvider('https://l.garyyang.work');

    await expect(provider.getLoginStatus('cslot_test')).resolves.toEqual({ status: 'expired' });
  });
});
