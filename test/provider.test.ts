import { afterEach, describe, expect, it, vi, type Mock } from 'vite-plus/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AppConfig } from '../src/config.js';
import { base62Encode, LGaryYangSlotBackend } from '../src/providers/l-garyyang.js';
import { createProvider } from '../src/providers/registry.js';
import { assertSupportsPublish, type PublishCapableProvider } from '../src/providers/types.js';

describe('l.garyyang signature URL', () => {
  it('encodes the slot helper in t2 instead of exposing slotId as an ignored query param', () => {
    const provider = new LGaryYangSlotBackend('https://l.garyyang.work');
    const url = new URL(
      provider.buildDirectPreviewUrl({
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
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: 'confirmed',
              credential: 'cred_test',
              user: {
                slotIds: ['slot_existing', 'slot_new']
              }
            })
          )
      )
    );

    const provider = new LGaryYangSlotBackend('https://l.garyyang.work');

    await expect(provider.getLoginStatus('cslot_test')).resolves.toEqual({
      status: 'confirmed',
      token: 'cred_test',
      slotId: 'slot_existing'
    });
  });

  it('keeps expired login status visible to the cli', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'expired' })))
    );

    const provider = new LGaryYangSlotBackend('https://l.garyyang.work');

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

  it('logs provider requests without leaking tokens or full slot values', async () => {
    const logPath = await useTempLogFile();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    );
    const provider = new LGaryYangSlotBackend('https://l.garyyang.work', {
      token: 'secret_token',
      slotId: 'slot_123456789abcdef'
    });

    await provider.updateSlot('sensitive rendered value');

    const line = await waitForLogLine(logPath);
    expect(line).toMatch(/^time=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00 /);
    expect(line).toContain('level=info');
    expect(line).toContain('app=agent-presence');
    expect(line).toContain('pid=');
    expect(line).toContain('type=provider.request');
    expect(line).toContain('provider=feishu-signature');
    expect(line).toContain('method=POST');
    expect(line).toContain('path=/api/slot/update');
    expect(line).toContain('status=200');
    expect(line).toContain('slotId=slot_1234567...');
    expect(line).toContain('valueLength=24');
    expect(line).toContain('result=updated');
    expect(line).not.toContain('secret_token');
    expect(line).not.toContain('sensitive rendered value');
    expect(line).not.toContain('slot_123456789abcdef');
  });

  it('logs rate limits as provider request events before throwing', async () => {
    const logPath = await useTempLogFile();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'too many requests' }), {
            status: 429,
            headers: { 'retry-after': '60' }
          })
      )
    );
    const provider = new LGaryYangSlotBackend('https://l.garyyang.work', {
      token: 'secret_token',
      slotId: 'slot_rate_limited'
    });

    await expect(provider.updateSlot('value')).rejects.toThrow('slot provider returned 429');

    const line = await waitForLogLine(logPath);
    expect(line).toContain('type=provider.request');
    expect(line).toContain('path=/api/slot/update');
    expect(line).toContain('status=429');
    expect(line).toContain('retryAfterMs=60000');
    expect(line).toContain('result=rate-limited');
  });

  it('does not log successful login polling by default', async () => {
    const logPath = await useTempLogFile();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'pending' })))
    );
    const provider = new LGaryYangSlotBackend('https://l.garyyang.work');

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
});

describe('publish timeout', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.AGENT_PRESENCE_LOG_FILE;
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  const config: AppConfig = { provider: 'feishu-signature', providerBaseUrl: 'https://provider.test' };
  const credential = { token: 'token_test', slotId: 'slot_test' };

  /** The failed publish logs its request; keep that write in a temporary log file of this describe. */
  async function useTempLogFile(): Promise<void> {
    tempDir = await mkdtemp(join(tmpdir(), 'agent-presence-provider-timeout-'));
    process.env.AGENT_PRESENCE_LOG_FILE = join(tempDir, 'agent-presence.log');
  }

  /** A fetch that never answers unless its signal aborts; it then rejects with that signal's reason. */
  function hangingFetch(): Mock<(url: unknown, init: { signal?: AbortSignal }) => Promise<never>> {
    return vi.fn<(url: unknown, init: { signal?: AbortSignal }) => Promise<never>>(
      (_url, init) =>
        new Promise<never>((_, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        })
    );
  }

  /**
   * The native timer behind `AbortSignal.timeout` cannot be faked; stand in for it on the fake clock, so the test
   * still pins that the publish asked for a 30-second timeout and aborts when it fires.
   */
  function fakeTimeoutSignal(): ReturnType<typeof vi.spyOn> {
    vi.useFakeTimers();
    return vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error(`publish timed out after ${ms}ms`)), ms);
      return controller.signal;
    });
  }

  function publishingProvider(): PublishCapableProvider {
    const provider = createProvider('feishu-signature', { config, credential });
    assertSupportsPublish(provider);
    return provider;
  }

  /**
   * Attach the outcome handler before any timer can fire: the rejection is then consumed in the same turn it
   * happens, whatever the fake clock's tick does around it.
   */
  function outcome(publishing: Promise<void>): Promise<unknown> {
    return publishing.then(
      () => 'resolved',
      (error: unknown) => error
    );
  }

  it('aborts the publish 30 seconds in even though the caller never aborts', async () => {
    await useTempLogFile();
    const timeoutSignal = fakeTimeoutSignal();
    const fetchMock = hangingFetch();
    vi.stubGlobal('fetch', fetchMock);

    const ended = outcome(publishingProvider().publishValue('2 agents'));
    await vi.advanceTimersByTimeAsync(29_999);
    const sent = fetchMock.mock.calls[0]?.[1];
    expect(sent?.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    expect(((await ended) as Error).message).toBe('publish timed out after 30000ms');
    expect(timeoutSignal).toHaveBeenCalledWith(30_000);
    // Run every timer the call left on the fake clock, so nothing rejects after the test is over.
    await vi.advanceTimersByTimeAsync(60_000);
  });

  it('aborts the publish when the caller aborts, with the reason the caller aborted it with', async () => {
    await useTempLogFile();
    fakeTimeoutSignal();
    vi.stubGlobal('fetch', hangingFetch());
    const caller = new AbortController();

    const ended = outcome(publishingProvider().publishValue('2 agents', { signal: caller.signal }));
    caller.abort(new Error('the worker stopped'));

    expect(((await ended) as Error).message).toBe('the worker stopped');
    await vi.advanceTimersByTimeAsync(60_000);
  });
});
