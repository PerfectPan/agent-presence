import {
  configSlotId,
  magicBuilderBaseUrl,
  magicBuilderFaasId,
  previewBaseUrl,
  previewImageKey,
  previewTargetUrl,
  providerBaseUrl,
  type AppConfig,
  type ProviderId
} from '../config.js';
import type { SlotCredential } from '../secret.js';
import { LGaryYangProvider } from './l-garyyang.js';
import { MagicBuilderProvider } from './magic-builder.js';
import type { PresenceProvider } from './types.js';

export interface CreateProviderOptions {
  config: AppConfig;
  credential?: SlotCredential;
}

export type ProviderFactory = (options: CreateProviderOptions) => PresenceProvider;

const factories: Record<ProviderId, ProviderFactory> = {
  'feishu-signature': createFeishuSignatureProvider,
  'magic-builder': createMagicBuilderProvider
};

/**
 * Resolve a provider id to a capability-oriented {@link PresenceProvider}.
 * This is the single place that knows which concrete classes back each id, so
 * CLI commands depend on capabilities rather than on `LGaryYangProvider`.
 */
export function createProvider(id: ProviderId, options: CreateProviderOptions): PresenceProvider {
  const factory = factories[id];
  if (!factory) {
    throw new Error(`unsupported provider: ${id}`);
  }
  return factory(options);
}

export function registeredProviderIds(): ProviderId[] {
  return Object.keys(factories) as ProviderId[];
}

function createFeishuSignatureProvider({ config, credential }: CreateProviderOptions): PresenceProvider {
  const slot = new LGaryYangProvider(providerBaseUrl(config), credential);
  return {
    id: 'feishu-signature',
    createQrCode: () => slot.createQrCode(),
    getLoginStatus: (sceneId) => slot.getLoginStatus(sceneId),
    updateSlot: (value) => slot.updateSlot(value),
    getInfo: () => slot.getInfo(),
    buildSignatureUrl: () => {
      const slotId = credential?.slotId ?? configSlotId(config);
      if (!slotId) {
        throw new Error('missing slot_id; run `agent-presence login` first');
      }
      return slot.buildSignatureUrl({
        slotId,
        imageKey: previewImageKey(config),
        targetUrl: previewTargetUrl(config),
        previewBaseUrl: previewBaseUrl(config)
      });
    }
  };
}

function createMagicBuilderProvider({ config, credential }: CreateProviderOptions): PresenceProvider {
  // magic-builder has no storage of its own: presence values are still written
  // to and read from the same l.garyyang slot. It only changes which URL Feishu
  // embeds, fronting the slot with a FaaS that Feishu reliably renders.
  const slot = new LGaryYangProvider(providerBaseUrl(config), credential);
  const frontEnd = new MagicBuilderProvider(magicBuilderBaseUrl(config));
  return {
    id: 'magic-builder',
    createQrCode: () => slot.createQrCode(),
    getLoginStatus: (sceneId) => slot.getLoginStatus(sceneId),
    updateSlot: (value) => slot.updateSlot(value),
    getInfo: () => slot.getInfo(),
    buildSignatureUrl: () => {
      const faasId = magicBuilderFaasId(config);
      if (!faasId) {
        throw new Error(
          'magic-builder provider has no published FaaS yet; run `agent-presence setup --provider magic-builder` first'
        );
      }
      return frontEnd.buildSignatureUrl(faasId);
    },
    getRemotePreview: () => {
      const faasId = magicBuilderFaasId(config);
      if (!faasId) {
        throw new Error('no published faas id; run `agent-presence setup --provider magic-builder` first');
      }
      return frontEnd.invokeFaas(faasId);
    }
  };
}
