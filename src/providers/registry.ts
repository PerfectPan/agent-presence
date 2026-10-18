import {
  configSlotId,
  magicBuilderBaseUrl,
  magicBuilderFaasId,
  previewBaseUrl,
  previewImageKey,
  previewTargetUrl,
  type AppConfig,
  type ProviderId
} from '../config.js';
import type { SlotCredential } from '../secret.js';
import { MagicBuilderProvider } from './magic-builder.js';
import { createSlotBackend, type SlotBackend } from './slot-backend.js';
import type { PresenceProvider } from './types.js';

export interface CreateProviderOptions {
  config: AppConfig;
  credential?: SlotCredential;
}

type ProviderFactory = (options: CreateProviderOptions) => PresenceProvider;

/** How long a publish may take before it is aborted, so a hanging provider cannot hold the applier. */
const PUBLISH_TIMEOUT_MS = 30_000;

/** The caller's signal, bounded by a timeout of its own so the request ends even when the caller waits forever. */
function publishSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(PUBLISH_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/** Capabilities every slot-backed provider shares, mapped onto the backend. */
function slotCapabilities(
  slot: SlotBackend
): Pick<PresenceProvider, 'createQrCode' | 'getLoginStatus' | 'publishValue' | 'getInfo'> {
  return {
    createQrCode: () => slot.createQrCode(),
    getLoginStatus: (sceneId) => slot.getLoginStatus(sceneId),
    publishValue: (value, options) => slot.updateSlot(value, { ...options, signal: publishSignal(options?.signal) }),
    getInfo: () => slot.getInfo()
  };
}

function createFeishuSignatureProvider({ config, credential }: CreateProviderOptions): PresenceProvider {
  const slot = createSlotBackend(config, credential);
  return {
    id: 'feishu-signature',
    ...slotCapabilities(slot),
    buildSignatureUrl: () => {
      const slotId = credential?.slotId ?? configSlotId(config);
      if (!slotId) {
        throw new Error('missing slot_id; run `agent-presence login` first');
      }
      return slot.buildDirectPreviewUrl({
        slotId,
        imageKey: previewImageKey(config),
        targetUrl: previewTargetUrl(config),
        previewBaseUrl: previewBaseUrl(config)
      });
    }
  };
}

function createMagicBuilderProvider({ config, credential }: CreateProviderOptions): PresenceProvider {
  // magic-builder has no storage of its own: it reads and writes the same slot
  // backend, and only changes which URL Feishu embeds — fronting the slot with
  // a FaaS that Feishu reliably renders.
  const slot = createSlotBackend(config, credential);
  const frontEnd = new MagicBuilderProvider(magicBuilderBaseUrl(config));
  return {
    id: 'magic-builder',
    ...slotCapabilities(slot),
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

// Partial: createProvider rejects ids without a factory, and that guard is a
// tested contract, so lookups stay fallible; `satisfies` still requires a
// factory for every ProviderId.
const factories: Partial<Record<ProviderId, ProviderFactory>> = {
  'feishu-signature': createFeishuSignatureProvider,
  'magic-builder': createMagicBuilderProvider
} satisfies Record<ProviderId, ProviderFactory>;

/**
 * Resolve a provider id to a capability-oriented {@link PresenceProvider}.
 * This is the single place that knows which concrete pieces back each id, so
 * CLI commands depend on capabilities rather than on a storage backend.
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
