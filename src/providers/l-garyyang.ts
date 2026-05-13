import { SlotRateLimitError } from '../render.js';
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

export class LGaryYangProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly credential?: SlotCredential
  ) {}

  async createQrCode(): Promise<QrCodeResponse> {
    const response = await this.requestJson('/api/slot/wechat/qrcode');
    if (!isRecord(response) || typeof response.sceneId !== 'string' || typeof response.qrcodeUrl !== 'string') {
      throw new Error('unexpected qrcode response from l.garyyang provider');
    }
    return {
      sceneId: response.sceneId,
      qrcodeUrl: response.qrcodeUrl,
      expiresIn: typeof response.expiresIn === 'number' ? response.expiresIn : 600
    };
  }

  async getLoginStatus(sceneId: string): Promise<LoginStatus> {
    const response = await this.requestJson(`/api/slot/wechat/login-status?sceneId=${encodeURIComponent(sceneId)}`);
    if (!isRecord(response) || typeof response.status !== 'string') {
      throw new Error('unexpected login status response from l.garyyang provider');
    }

    const token = pickString(response, ['token', 'authToken', 'accessToken', 'credential'], ['data', 'credential']);
    const slotId = pickSlotId(response);
    if (token && slotId) {
      return { status: response.status, token, slotId };
    }

    return { status: response.status };
  }

  async updateSlot(value: string): Promise<void> {
    const credential = this.requireCredential();
    await this.requestJson('/api/slot/update', {
      method: 'POST',
      headers: this.authHeaders(credential),
      body: JSON.stringify({ slotId: credential.slotId, value })
    });
  }

  async getInfo(): Promise<unknown> {
    return await this.requestJson('/api/slot/info', {
      headers: this.authHeaders(this.requireCredential())
    });
  }

  buildSignatureUrl(options: { slotId: string; imageKey?: string; targetUrl?: string; previewBaseUrl: string }): string {
    const url = new URL(options.previewBaseUrl);
    url.searchParams.set('t2', base62Encode(`{{slot id="${options.slotId}"}}`));
    if (options.imageKey) {
      url.searchParams.set('k', options.imageKey);
    }
    if (options.targetUrl) {
      url.searchParams.set('u', options.targetUrl);
    }
    return url.toString();
  }

  private requireCredential(): SlotCredential {
    if (!this.credential) {
      throw new Error('missing slot credential; run `agent-presence login` first or set env credentials');
    }
    return this.credential;
  }

  private authHeaders(credential: SlotCredential): Record<string, string> {
    return {
      Authorization: `Bearer ${credential.token}`,
      'Content-Type': 'application/json'
    };
  }

  private async requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(new URL(path, this.baseUrl), init);
    const text = await response.text();
    const json = text ? parseJson(text) : undefined;

    if (response.status === 429) {
      throw new SlotRateLimitError('slot provider returned 429', readRetryAfter(response.headers.get('retry-after')));
    }

    if (!response.ok) {
      const detail = isRecord(json) && typeof json.error === 'string' ? json.error : text;
      throw new Error(`l.garyyang provider request failed: ${response.status} ${detail}`);
    }

    return json;
  }
}

const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function base62Encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length === 0) {
    return '';
  }

  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const next = digits[index]! * 256 + carry;
      digits[index] = next % 62;
      carry = Math.floor(next / 62);
    }
    while (carry > 0) {
      digits.push(carry % 62);
      carry = Math.floor(carry / 62);
    }
  }

  let output = '';
  for (const byte of bytes) {
    if (byte === 0) {
      output += BASE62_ALPHABET[0];
    } else {
      break;
    }
  }
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    output += BASE62_ALPHABET[digits[index]!];
  }
  return output;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('l.garyyang provider returned non-json response');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function pickString(root: Record<string, unknown>, directKeys: string[], nestedKeys: string[]): string | undefined {
  for (const key of directKeys) {
    if (typeof root[key] === 'string') {
      return root[key];
    }
  }

  for (const nestedKey of nestedKeys) {
    const nested = root[nestedKey];
    if (!isRecord(nested)) {
      continue;
    }
    for (const key of directKeys) {
      if (typeof nested[key] === 'string') {
        return nested[key];
      }
    }
  }

  return undefined;
}

function pickSlotId(root: Record<string, unknown>): string | undefined {
  const direct = pickString(root, ['slotId', 'slot_id'], ['data', 'slot']);
  if (direct) {
    return direct;
  }

  for (const parent of [root, root.data, root.user]) {
    if (!isRecord(parent)) {
      continue;
    }

    const fromParent = pickFirstString(parent.slotIds) ?? pickFirstString(parent.slot_ids);
    if (fromParent) {
      return fromParent;
    }

    if (isRecord(parent.user)) {
      const fromNestedUser = pickFirstString(parent.user.slotIds) ?? pickFirstString(parent.user.slot_ids);
      if (fromNestedUser) {
        return fromNestedUser;
      }
    }
  }

  return undefined;
}

function pickFirstString(value: unknown): string | undefined {
  return Array.isArray(value) ? value.find((item): item is string => typeof item === 'string' && item.length > 0) : undefined;
}

function readRetryAfter(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}
