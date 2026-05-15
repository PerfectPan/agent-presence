import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
    delete process.env.AGENT_PRESENCE_LOG_FILE;
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

describe('l.garyyang request logging', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.AGENT_PRESENCE_LOG_FILE;
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('logs provider requests without leaking tokens or full slot values', async () => {
    const logPath = await useTempLogFile();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    const provider = new LGaryYangProvider('https://l.garyyang.work', {
      token: 'secret_token',
      slotId: 'slot_123456789abcdef'
    });

    await provider.updateSlot('sensitive rendered value');

    const line = await waitForLogLine(logPath);
    const event = JSON.parse(line) as Record<string, unknown>;
    expect(event).toMatchObject({
      app: 'agent-presence',
      type: 'provider.request',
      provider: 'feishu-signature',
      method: 'POST',
      path: '/api/slot/update',
      status: 200,
      slotId: 'slot_1234567...',
      valueLength: 24,
      result: 'updated'
    });
    expect(typeof event.pid).toBe('number');
    expect(line).not.toContain('secret_token');
    expect(line).not.toContain('sensitive rendered value');
    expect(line).not.toContain('slot_123456789abcdef');
  });

  it('logs rate limits as provider request events before throwing', async () => {
    const logPath = await useTempLogFile();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'too many requests' }), {
        status: 429,
        headers: { 'retry-after': '60' }
      }))
    );
    const provider = new LGaryYangProvider('https://l.garyyang.work', {
      token: 'secret_token',
      slotId: 'slot_rate_limited'
    });

    await expect(provider.updateSlot('value')).rejects.toThrow('slot provider returned 429');

    const event = JSON.parse(await waitForLogLine(logPath)) as Record<string, unknown>;
    expect(event).toMatchObject({
      type: 'provider.request',
      path: '/api/slot/update',
      status: 429,
      retryAfterMs: 60000,
      result: 'rate-limited'
    });
  });

  it('does not log successful login polling by default', async () => {
    const logPath = await useTempLogFile();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'pending' }))));
    const provider = new LGaryYangProvider('https://l.garyyang.work');

    await expect(provider.getLoginStatus('cslot_test')).resolves.toEqual({ status: 'pending' });

    await expect
      .poll(async () => {
        try {
          return await readFile(logPath, 'utf8');
        } catch {
          return '';
        }
      })
      .toBe('');
  });

  async function useTempLogFile(): Promise<string> {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-presence-provider-test-'));
    const logPath = join(tempDir, 'agent-presence.log');
    process.env.AGENT_PRESENCE_LOG_FILE = logPath;
    return logPath;
  }

  async function waitForLogLine(path: string): Promise<string> {
    await expect
      .poll(async () => {
        try {
          return (await readFile(path, 'utf8')).trim();
        } catch {
          return '';
        }
      })
      .not.toBe('');
    return (await readFile(path, 'utf8')).trim();
  }
});
