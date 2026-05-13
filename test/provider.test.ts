import { describe, expect, it } from 'vitest';
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
