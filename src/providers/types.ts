import type { ProviderId } from '../config.js';
import type { LoginStatus, QrCodeResponse } from './l-garyyang.js';

export type { LoginStatus, QrCodeResponse } from './l-garyyang.js';

/**
 * The capability-oriented seam every CLI command resolves through, instead of
 * importing a concrete provider class. A provider only implements the methods
 * it actually supports; commands call `assertSupports*` to fail loudly with a
 * clear message when a selected provider lacks the capability they need.
 *
 * Both shipped providers write presence to the same slot backend, so
 * `createQrCode`/`getLoginStatus`/`updateSlot`/`getInfo` behave identically.
 * They differ only in how the value reaches Feishu: `buildSignatureUrl`
 * (which URL the signature embeds) and `getRemotePreview` (the optional
 * server-rendered preview a front-end provider exposes).
 */
export interface PresenceProvider {
  readonly id: ProviderId;
  /** QR login (slot-style providers). */
  createQrCode?(): Promise<QrCodeResponse>;
  getLoginStatus?(sceneId: string): Promise<LoginStatus>;
  /** Publish the rendered presence value to wherever this provider stores it. */
  publishValue?(value: string): Promise<void>;
  /** Raw backend info, used by `status --remote`. */
  getInfo?(): Promise<unknown>;
  /** The link-preview URL the Feishu signature should embed. */
  buildSignatureUrl?(): string;
  /**
   * A front-end provider's own server-rendered preview (e.g. the magic-builder
   * FaaS output). Distinct from `getInfo`, which reads the raw slot value.
   */
  getRemotePreview?(): Promise<unknown>;
}

export type LoginCapableProvider = PresenceProvider &
  Required<Pick<PresenceProvider, 'createQrCode' | 'getLoginStatus'>>;

export type PublishCapableProvider = PresenceProvider & Required<Pick<PresenceProvider, 'publishValue'>>;

export type SignatureUrlCapableProvider = PresenceProvider & Required<Pick<PresenceProvider, 'buildSignatureUrl'>>;

export function assertSupportsLogin(provider: PresenceProvider): asserts provider is LoginCapableProvider {
  if (!provider.createQrCode || !provider.getLoginStatus) {
    throw new Error(`provider "${provider.id}" does not support login`);
  }
}

export function assertSupportsPublish(provider: PresenceProvider): asserts provider is PublishCapableProvider {
  if (!provider.publishValue) {
    throw new Error(`provider "${provider.id}" does not support publishing values`);
  }
}

export function assertSupportsSignatureUrl(provider: PresenceProvider): asserts provider is SignatureUrlCapableProvider {
  if (!provider.buildSignatureUrl) {
    throw new Error(`provider "${provider.id}" does not build signature urls`);
  }
}
