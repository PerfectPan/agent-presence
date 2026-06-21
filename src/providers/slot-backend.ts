import { providerBaseUrl, type AppConfig } from '../config.js';
import type { SlotCredential } from '../secret.js';
import { LGaryYangSlotBackend, type LoginStatus, type QrCodeResponse } from './l-garyyang.js';

export interface SlotPreviewUrlOptions {
  slotId: string;
  imageKey?: string;
  targetUrl?: string;
  previewBaseUrl: string;
}

/**
 * The shared remote value store. Both shipped signature providers
 * (`feishu-signature` and `magic-builder`) read and write the *same* slot, so
 * this is a single backend they compose — not something one provider owns and
 * the other depends on. A future provider with its own storage would implement
 * {@link PresenceProvider} directly and never touch a `SlotBackend`.
 */
export interface SlotBackend {
  createQrCode(): Promise<QrCodeResponse>;
  getLoginStatus(sceneId: string): Promise<LoginStatus>;
  /** Write the rendered presence value to the slot. */
  updateSlot(value: string): Promise<void>;
  /** Raw slot read, surfaced by `status --remote`. */
  getInfo(): Promise<unknown>;
  /** The backend's own direct link-preview URL (used by `feishu-signature`). */
  buildDirectPreviewUrl(options: SlotPreviewUrlOptions): string;
}

/** Resolve the configured slot backend. l.garyyang is currently the only one. */
export function createSlotBackend(config: AppConfig, credential?: SlotCredential): SlotBackend {
  return new LGaryYangSlotBackend(providerBaseUrl(config), credential);
}
