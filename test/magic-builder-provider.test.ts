import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MagicBuilderProvider } from '../src/providers/magic-builder.js';

const originalFetch = globalThis.fetch;

describe('MagicBuilderProvider.buildSignatureUrl', () => {
  it('returns /r?fid=<id> on the configured base url', () => {
    const provider = new MagicBuilderProvider('https://magic.solutionsuite.cn');
    expect(provider.buildSignatureUrl('rec_abc123')).toBe('https://magic.solutionsuite.cn/r?fid=rec_abc123');
  });

  it('url-encodes ids that contain unsafe characters', () => {
    const provider = new MagicBuilderProvider('https://magic.solutionsuite.cn');
    expect(provider.buildSignatureUrl('rec abc')).toBe('https://magic.solutionsuite.cn/r?fid=rec%20abc');
  });

  it('respects custom base url', () => {
    const provider = new MagicBuilderProvider('https://magic.staging.example.com/');
    expect(provider.buildSignatureUrl('xyz')).toBe('https://magic.staging.example.com/r?fid=xyz');
  });
});

describe('MagicBuilderProvider.buildDirectTitleUrl', () => {
  it('produces a static r?title= URL for fallback usage', () => {
    const provider = new MagicBuilderProvider('https://magic.solutionsuite.cn');
    expect(provider.buildDirectTitleUrl('AI 牛马摸鱼中')).toBe(
      'https://magic.solutionsuite.cn/r?title=AI+%E7%89%9B%E9%A9%AC%E6%91%B8%E9%B1%BC%E4%B8%AD'
    );
  });
});

describe('MagicBuilderProvider.buildFaasCode', () => {
  it('embeds slot id, bearer, slot info URL, fallback title, and expire_strategy', () => {
    const code = new MagicBuilderProvider('https://magic.solutionsuite.cn').buildFaasCode({
      slotId: 'slot_abc',
      slotBearer: 'tok_secret',
      slotBaseUrl: 'https://l.garyyang.work',
      fallbackTitle: 'AI 牛马暂未开工'
    });

    expect(code).toContain('module.exports = async function (request, context) {');
    expect(code).toContain('"slotId": "slot_abc"');
    expect(code).toContain('"slotBearer": "tok_secret"');
    expect(code).toContain('"slotInfoUrl": "https://l.garyyang.work/api/slot/info"');
    expect(code).toContain('"fallbackTitle": "AI 牛马暂未开工"');
    expect(code).toContain('"expireStrategy": "60s"');
    expect(code).toContain('Authorization');
    expect(code).toContain('i18n_title');
    expect(code).toContain('expire_strategy');
  });

  it('strips trailing slashes from slot base url before joining /api/slot/info', () => {
    const code = new MagicBuilderProvider('https://magic.solutionsuite.cn').buildFaasCode({
      slotId: 'slot_abc',
      slotBearer: 'tok',
      slotBaseUrl: 'https://l.garyyang.work//',
      fallbackTitle: 'fb'
    });
    expect(code).toContain('"slotInfoUrl": "https://l.garyyang.work/api/slot/info"');
  });

  it('respects custom expireStrategy and image_key', () => {
    const code = new MagicBuilderProvider('https://magic.solutionsuite.cn').buildFaasCode({
      slotId: 'slot',
      slotBearer: 'tok',
      slotBaseUrl: 'https://l.garyyang.work',
      fallbackTitle: 'fb',
      expireStrategy: '1h',
      imageKey: 'img_xxx'
    });
    expect(code).toContain('"expireStrategy": "1h"');
    expect(code).toContain('"imageKey": "img_xxx"');
  });
});

describe('MagicBuilderProvider.publishFaas', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  });

  it('POSTs CommonJS code to /api/faas with bearer auth and returns the record id', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 0, data: { id: 'rec_xyz', record_id: 'rec_xyz' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const provider = new MagicBuilderProvider('https://magic.solutionsuite.cn', 'tok_secret');
    const result = await provider.publishFaas({ code: 'module.exports = ...', name: 'agent_presence_preview' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://magic.solutionsuite.cn/api/faas');
    expect((init as RequestInit).method).toBe('POST');
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('Authorization')).toBe('Bearer tok_secret');
    expect(headers.get('Content-Type')).toBe('application/json');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toEqual({ code: 'module.exports = ...', name: 'agent_presence_preview' });
    expect(result).toEqual({
      id: 'rec_xyz',
      recordId: 'rec_xyz',
      faasPath: '/api/faas/rec_xyz',
      previewPath: '/r?fid=rec_xyz'
    });
  });

  it('forwards an existing record id as `id` so the FaaS is updated in place', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 0, data: { id: 'rec_old', record_id: 'rec_old' } }), {
        status: 200
      })
    );

    const provider = new MagicBuilderProvider('https://magic.solutionsuite.cn', 'tok');
    await provider.publishFaas({ code: 'x', name: 'n', recordId: 'rec_old' });
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.id).toBe('rec_old');
  });

  it('throws a clear error when the token is missing', async () => {
    const provider = new MagicBuilderProvider('https://magic.solutionsuite.cn');
    await expect(provider.publishFaas({ code: 'x' })).rejects.toThrow(/missing magic-builder token/);
  });

  it('surfaces application errors from magic.solutionsuite.cn', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 401, msg: 'invalid token' }), { status: 200 })
    );
    const provider = new MagicBuilderProvider('https://magic.solutionsuite.cn', 'bad');
    await expect(provider.publishFaas({ code: 'x' })).rejects.toThrow(/invalid token/);
  });

  it('surfaces transport-level failures', async () => {
    fetchMock.mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    const provider = new MagicBuilderProvider('https://magic.solutionsuite.cn', 'tok');
    await expect(provider.publishFaas({ code: 'x' })).rejects.toThrow(/401/);
  });
});

describe('MagicBuilderProvider.invokeFaas', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  });

  it('parses i18n_title.zh_cn and expire_strategy out of the response', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          inline: { i18n_title: { zh_cn: '4 个 AI 牛马并行搬砖' } },
          expire_strategy: '60s'
        }),
        { status: 200 }
      )
    );
    const result = await new MagicBuilderProvider('https://magic.solutionsuite.cn').invokeFaas('rec_abc');
    expect(result.title).toBe('4 个 AI 牛马并行搬砖');
    expect(result.expireStrategy).toBe('60s');
  });
});
