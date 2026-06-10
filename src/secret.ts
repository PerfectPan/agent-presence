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

export interface CredentialStore {
  readCredential(configSlotId?: string): Promise<SlotCredential | undefined>;
  writeCredential(credential: SlotCredential): Promise<void>;
  deleteCredential(): Promise<void>;
}

export interface CredentialStoreOptions {
  keychainService?: string;
  keychainLegacyService?: string;
  libsecretService?: string;
}

interface CredentialBackend {
  readToken(): Promise<string | undefined>;
  readSlotId(): Promise<string | undefined>;
  writeCredential(credential: SlotCredential): Promise<void>;
  deleteCredential(): Promise<void>;
}

export async function readCredential(configSlotId?: string): Promise<SlotCredential | undefined> {
  return createCredentialStore().readCredential(configSlotId);
}

export async function writeCredential(credential: SlotCredential): Promise<void> {
  await createCredentialStore().writeCredential(credential);
}

export async function deleteCredential(): Promise<void> {
  await createCredentialStore().deleteCredential();
}

export interface GenericSecretStore {
  read(): Promise<string | undefined>;
  write(value: string): Promise<void>;
  delete(): Promise<void>;
}

/**
 * A single named secret value stored in the same OS-keyring backends the slot
 * credential uses (macOS Keychain, Linux libsecret). Used for secrets that are
 * not the l.garyyang slot credential, e.g. the magic-builder publish token.
 */
export function createGenericSecretStore(service: string, account: string): GenericSecretStore {
  if (process.platform === 'linux') {
    return {
      async read() {
        if (!(await hasSecretTool())) {
          return undefined;
        }
        return readSecretTool(service, account);
      },
      async write(value) {
        await ensureSecretTool();
        await writeSecretTool(service, account, value);
      },
      async delete() {
        if (await hasSecretTool()) {
          await deleteSecretTool(service, account);
        }
      }
    };
  }
  return {
    read() {
      return readKeychain(service, account);
    },
    async write(value) {
      await writeKeychain(service, account, value);
    },
    async delete() {
      await deleteKeychain(service, account);
    }
  };
}

export function createCredentialStore(options: CredentialStoreOptions = {}): CredentialStore {
  const backend = getCredentialBackend(options);
  return {
    async readCredential(configSlotId?: string) {
      const token = envToken() ?? (await backend.readToken());
      const slotId = envSlotId() ?? (await backend.readSlotId()) ?? configSlotId;

      if (!token || !slotId) {
        return undefined;
      }

      return { token, slotId };
    },

    writeCredential(credential) {
      return backend.writeCredential(credential);
    },

    deleteCredential() {
      return backend.deleteCredential();
    }
  };
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

function getCredentialBackend(options: CredentialStoreOptions): CredentialBackend {
  if (process.platform === 'linux') {
    return createSecretToolBackend(options.libsecretService ?? LIBSECRET_SERVICE);
  }
  return createKeychainBackend(
    options.keychainService ?? KEYCHAIN_SERVICE,
    options.keychainLegacyService ?? KEYCHAIN_LEGACY_SERVICE
  );
}

// --- macOS Keychain backend ---

function createKeychainBackend(service: string, legacyService: string): CredentialBackend {
  return {
    async readToken() {
      return (
        (await readKeychain(service, 'token')) ??
        (await readKeychain(legacyService, process.env.USER ?? 'agent-presence'))
      );
    },

    async readSlotId() {
      return readKeychain(service, 'slotId');
    },

    async writeCredential(credential) {
      await writeKeychain(service, 'token', credential.token);
      await writeKeychain(service, 'slotId', credential.slotId);
    },

    async deleteCredential() {
      await Promise.all([
        deleteKeychain(service, 'token'),
        deleteKeychain(service, 'slotId'),
        deleteKeychain(legacyService, process.env.USER ?? 'agent-presence')
      ]);
    }
  };
}

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

function createSecretToolBackend(service: string): CredentialBackend {
  return {
    async readToken() {
      await ensureSecretTool();
      return readSecretTool(service, 'token');
    },

    async readSlotId() {
      await ensureSecretTool();
      return readSecretTool(service, 'slotId');
    },

    async writeCredential(credential) {
      await ensureSecretTool();
      await writeSecretTool(service, 'token', credential.token);
      await writeSecretTool(service, 'slotId', credential.slotId);
    },

    async deleteCredential() {
      await ensureSecretTool();
      await deleteSecretTool(service, 'token');
      await deleteSecretTool(service, 'slotId');
    }
  };
}

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

async function readSecretTool(service: string, account: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('secret-tool', ['lookup', 'service', service, 'account', account], {
      encoding: 'utf8'
    });
    const value = stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function writeSecretTool(service: string, account: string, value: string): Promise<void> {
  // execFile supports `input` at runtime but @types/node excludes it from overloads.
  await execFileAsync('secret-tool', ['store', '--label', service, 'service', service, 'account', account], { input: value } as any);
}

async function deleteSecretTool(service: string, account: string): Promise<void> {
  await execFileAsync('secret-tool', ['clear', 'service', service, 'account', account]).catch(() => undefined);
}
