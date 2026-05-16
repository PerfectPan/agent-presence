import type { SlotCredential } from '../secret.js';

export interface QrCodeResponse {
  sceneId: string;
  qrcodeUrl: string;
  expiresIn: number;
}

export interface LoginPending {
  status: string;
}

export interface LoginSuccess {
  status: string;
  token: string;
  slotId: string;
}

export type LoginStatus = LoginPending | LoginSuccess;

export interface BuildSignatureUrlOptions {
  slotId: string;
  imageKey?: string;
  targetUrl?: string;
  previewBaseUrl: string;
}

export interface PresenceProvider {
  readonly id: string;
  createQrCode?(): Promise<QrCodeResponse>;
  getLoginStatus?(sceneId: string): Promise<LoginStatus>;
  updateSlot?(value: string): Promise<void>;
  getInfo?(): Promise<unknown>;
  buildSignatureUrl?(options: BuildSignatureUrlOptions): string;
}

export interface ProviderOptions {
  baseUrl: string;
  credential?: SlotCredential;
}

export type LoginCapableProvider = PresenceProvider &
  Required<Pick<PresenceProvider, 'createQrCode' | 'getLoginStatus'>>;

export type SlotUpdateCapableProvider = PresenceProvider &
  Required<Pick<PresenceProvider, 'updateSlot'>>;

export type RemoteInfoCapableProvider = PresenceProvider &
  Required<Pick<PresenceProvider, 'getInfo'>>;

export type SignatureUrlCapableProvider = PresenceProvider &
  Required<Pick<PresenceProvider, 'buildSignatureUrl'>>;

export function assertSupportsLogin(provider: PresenceProvider): asserts provider is LoginCapableProvider {
  if (!provider.createQrCode || !provider.getLoginStatus) {
    throw new Error(`provider "${provider.id}" does not support login`);
  }
}

export function assertSupportsSlotUpdate(provider: PresenceProvider): asserts provider is SlotUpdateCapableProvider {
  if (!provider.updateSlot) {
    throw new Error(`provider "${provider.id}" does not support slot updates`);
  }
}

export function assertSupportsRemoteInfo(provider: PresenceProvider): asserts provider is RemoteInfoCapableProvider {
  if (!provider.getInfo) {
    throw new Error(`provider "${provider.id}" does not expose remote info`);
  }
}

export function assertSupportsSignatureUrl(provider: PresenceProvider): asserts provider is SignatureUrlCapableProvider {
  if (!provider.buildSignatureUrl) {
    throw new Error(`provider "${provider.id}" does not build signature urls`);
  }
}
