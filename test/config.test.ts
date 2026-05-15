import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  configSlotId,
  feishuSignatureConfig,
  getConfigPath,
  getHomeDir,
  loadConfig,
  providerBaseUrl,
  providerId,
  renderTemplates
} from '../src/config.js';

describe('renderTemplates', () => {
  it('omits unset template keys instead of overriding defaults with undefined', () => {
    expect(renderTemplates({})).toEqual({});
  });

  it('merges configured copy with environment overrides', () => {
    vi.stubEnv('AGENT_SIGNATURE_RENDER_ZERO', '机器歇菜中');
    vi.stubEnv('AGENT_SIGNATURE_RENDER_MANY', '{total} 个 AI 牛马正在赶工 | {details}');

    expect(
      renderTemplates({
        render: {
          zero: 'AI 牛马下班了',
          one: '{total} 个 AI 牛马正在搬砖 | {details}',
          many: '{total} 个 AI 牛马并行搬砖 | {details}'
        }
      })
    ).toEqual({
      zero: '机器歇菜中',
      one: '{total} 个 AI 牛马正在搬砖 | {details}',
      many: '{total} 个 AI 牛马正在赶工 | {details}'
    });

    vi.unstubAllEnvs();
  });
});

describe('agent-presence env aliases', () => {
  it('prefers AGENT_PRESENCE env names while keeping legacy AGENT_SIGNATURE names', () => {
    vi.stubEnv('AGENT_SIGNATURE_PROVIDER_BASE_URL', 'https://legacy.example.com');
    vi.stubEnv('AGENT_PRESENCE_PROVIDER_BASE_URL', 'https://presence.example.com');
    vi.stubEnv('AGENT_SIGNATURE_SLOT_ID', 'slot_legacy');
    vi.stubEnv('AGENT_PRESENCE_SLOT_ID', 'slot_presence');

    expect(providerBaseUrl({})).toBe('https://presence.example.com');
    expect(configSlotId({})).toBe('slot_presence');

    vi.unstubAllEnvs();
  });
});

describe('home directory', () => {
  it('defaults durable files to ~/.agent-presence', () => {
    vi.stubEnv('HOME', '/Users/example');
    vi.stubEnv('AGENT_PRESENCE_HOME', '');
    vi.stubEnv('AGENT_SIGNATURE_HOME', '');
    vi.unstubAllEnvs();
    vi.stubEnv('HOME', '/Users/example');

    expect(getHomeDir()).toBe('/Users/example/.agent-presence');
    expect(getConfigPath()).toBe('/Users/example/.agent-presence/config.json');

    vi.unstubAllEnvs();
  });

  it('reads a legacy config when the new config does not exist', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agent-presence-config-test-'));
    vi.stubEnv('HOME', home);
    const legacyDir = join(home, '.codex', 'agent-signature');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(join(legacyDir, 'config.json'), JSON.stringify({ slot_id: 'slot_legacy' }));

    await expect(loadConfig()).resolves.toMatchObject({ slot_id: 'slot_legacy' });
    expect(getConfigPath()).toBe(join(home, '.agent-presence', 'config.json'));

    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });
});

describe('provider configuration', () => {
  it('normalizes the legacy l-garyyang provider name to feishu-signature', () => {
    expect(providerId({ provider: 'l-garyyang' })).toBe('feishu-signature');
    expect(providerId({ provider: 'feishu-signature' })).toBe('feishu-signature');
  });

  it('reads Feishu signature provider config from provider-specific fields before legacy fields', () => {
    const config = {
      provider: 'feishu-signature' as const,
      providerBaseUrl: 'https://legacy.example.com',
      previewTargetUrl: 'https://legacy-target.example.com',
      providers: {
        'feishu-signature': {
          baseUrl: 'https://slot.example.com',
          previewBaseUrl: 'https://preview.example.com/',
          previewImageKey: 'img_test',
          previewTargetUrl: 'https://target.example.com'
        }
      }
    };

    expect(providerBaseUrl(config)).toBe('https://slot.example.com');
    expect(feishuSignatureConfig(config)).toEqual({
      baseUrl: 'https://slot.example.com',
      previewBaseUrl: 'https://preview.example.com/',
      previewImageKey: 'img_test',
      previewTargetUrl: 'https://target.example.com'
    });
  });
});
