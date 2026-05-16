import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface SlotCredential {
  token: string;
  slotId: string;
}

const KEYCHAIN_SERVICE = 'agent-signature:l-garyyang';
const KEYCHAIN_LEGACY_SERVICE = 'agent-signature-slot-credential';
const LIBSECRET_SERVICE = 'agent-presence';
const LIBSECRET_ERROR =
  'agent-presence requires libsecret on linux (install gnome-keyring or libsecret-tools)';

interface CredentialBackend {
  readToken(): Promise<string | undefined>;
  readSlotId(): Promise<string | undefined>;
  writeCredential(credential: SlotCredential): Promise<void>;
  deleteCredential(): Promise<void>;
}

export async function readCredential(configSlotId?: string): Promise<SlotCredential | undefined> {
  const token = envToken() ?? (await getCredentialBackend().readToken());
  const slotId = envSlotId() ?? (await getCredentialBackend().readSlotId()) ?? configSlotId;

  if (!token || !slotId) {
    return undefined;
  }

  return { token, slotId };
}

export async function writeCredential(credential: SlotCredential): Promise<void> {
  await getCredentialBackend().writeCredential(credential);
}

export async function deleteCredential(): Promise<void> {
  await getCredentialBackend().deleteCredential();
}

function envToken(): string | undefined {
  return (
    process.env.AGENT_PRESENCE_L_GARYYANG_TOKEN ??
    process.env.AGENT_PRESENCE_TOKEN ??
    process.env.AGENT_SIGNATURE_L_GARYYANG_TOKEN ??
    process.env.AGENT_SIGNATURE_TOKEN ??
    process.env.FEISHU_SLOT_CREDENTIAL
  );
}

function envSlotId(): string | undefined {
  return (
    process.env.AGENT_PRESENCE_L_GARYYANG_SLOT_ID ??
    process.env.AGENT_PRESENCE_SLOT_ID ??
    process.env.AGENT_SIGNATURE_L_GARYYANG_SLOT_ID ??
    process.env.AGENT_SIGNATURE_SLOT_ID
  );
}

// --- Backend selection ---

function getCredentialBackend(): CredentialBackend {
  if (process.platform === 'linux') {
    return secretToolBackend;
  }
  return keychainBackend;
}

// --- macOS Keychain backend ---

const keychainBackend: CredentialBackend = {
  async readToken() {
    return (await readKeychain(KEYCHAIN_SERVICE, 'token')) ?? (await readKeychain(KEYCHAIN_LEGACY_SERVICE, process.env.USER ?? 'agent-presence'));
  },

  async readSlotId() {
    return readKeychain(KEYCHAIN_SERVICE, 'slotId');
  },

  async writeCredential(credential) {
    await writeKeychain(KEYCHAIN_SERVICE, 'token', credential.token);
    await writeKeychain(KEYCHAIN_SERVICE, 'slotId', credential.slotId);
  },

  async deleteCredential() {
    await Promise.all([
      deleteKeychain(KEYCHAIN_SERVICE, 'token'),
      deleteKeychain(KEYCHAIN_SERVICE, 'slotId'),
      deleteKeychain(KEYCHAIN_LEGACY_SERVICE, process.env.USER ?? 'agent-presence')
    ]);
  }
};

async function readKeychain(service: string, account: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
      encoding: 'utf8'
    });
    const value = stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function writeKeychain(service: string, account: string, value: string): Promise<void> {
  await execFileAsync('security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', value]);
}

async function deleteKeychain(service: string, account: string): Promise<void> {
  await execFileAsync('security', ['delete-generic-password', '-s', service, '-a', account]).catch(() => undefined);
}

// --- Linux libsecret backend ---

const secretToolBackend: CredentialBackend = {
  async readToken() {
    await ensureSecretTool();
    return readSecretTool('token');
  },

  async readSlotId() {
    await ensureSecretTool();
    return readSecretTool('slotId');
  },

  async writeCredential(credential) {
    await ensureSecretTool();
    await writeSecretTool('token', credential.token);
    await writeSecretTool('slotId', credential.slotId);
  },

  async deleteCredential() {
    await ensureSecretTool();
    await deleteSecretTool('token');
    await deleteSecretTool('slotId');
  }
};

async function ensureSecretTool(): Promise<void> {
  if (!(await hasSecretTool())) {
    throw new Error(LIBSECRET_ERROR);
  }
}

async function hasSecretTool(): Promise<boolean> {
  try {
    await execFileAsync('secret-tool', ['--version']);
    return true;
  } catch {
    return false;
  }
}

async function readSecretTool(account: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('secret-tool', ['lookup', 'service', LIBSECRET_SERVICE, 'account', account], {
      encoding: 'utf8'
    });
    const value = stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function writeSecretTool(account: string, value: string): Promise<void> {
  // execFile supports `input` at runtime but @types/node excludes it from overloads.
  await execFileAsync('secret-tool', ['store', '--label', LIBSECRET_SERVICE, 'service', LIBSECRET_SERVICE, 'account', account], { input: value } as any);
}

async function deleteSecretTool(account: string): Promise<void> {
  await execFileAsync('secret-tool', ['clear', 'service', LIBSECRET_SERVICE, 'account', account]).catch(() => undefined);
}
