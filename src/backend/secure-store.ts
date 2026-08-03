import type {
  CredentialState,
  EncryptedRecord,
  OAuthCredentials,
  PluginAPI,
  TokenRecord,
} from '../shared/types.js';

function requireSafeStorage(api: PluginAPI): void {
  if (!api.safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-protected storage is unavailable. Rally credentials were not saved.');
  }
}

function encryptRecord<T>(api: PluginAPI, value: T, hint?: string): EncryptedRecord {
  requireSafeStorage(api);
  return {
    version: 1,
    ciphertext: api.safeStorage.encryptString(JSON.stringify(value)),
    hint,
  };
}

function decryptRecord<T>(api: PluginAPI, record: unknown): T | null {
  if (!record || typeof record !== 'object') return null;
  const value = record as Partial<EncryptedRecord>;
  if (value.version !== 1 || typeof value.ciphertext !== 'string') return null;
  requireSafeStorage(api);
  return JSON.parse(api.safeStorage.decryptString(value.ciphertext)) as T;
}

function credentialHint(clientId: string): string {
  if (clientId.length <= 10) return `${clientId.slice(0, 3)}…`;
  return `${clientId.slice(0, 6)}…${clientId.slice(-4)}`;
}

export function saveCredentials(api: PluginAPI, credentials: OAuthCredentials): void {
  const clientId = credentials.clientId.trim();
  const clientSecret = credentials.clientSecret.trim();
  if (!clientId || !clientSecret) throw new Error('Client ID and client secret are required.');
  api.config.setPluginData(
    'encryptedCredentials',
    encryptRecord(api, { clientId, clientSecret }, credentialHint(clientId)),
  );
}

export function loadCredentials(api: PluginAPI): OAuthCredentials | null {
  return decryptRecord<OAuthCredentials>(api, api.config.getPluginData().encryptedCredentials);
}

export function clearCredentials(api: PluginAPI): void {
  api.config.setPluginData('encryptedCredentials', null);
}

export function credentialState(api: PluginAPI): CredentialState {
  const record = api.config.getPluginData().encryptedCredentials as Partial<EncryptedRecord> | undefined;
  let encryptionAvailable = false;
  try {
    encryptionAvailable = api.safeStorage.isEncryptionAvailable();
  } catch {
    encryptionAvailable = false;
  }
  return {
    configured: Boolean(record?.ciphertext),
    clientIdHint: typeof record?.hint === 'string' ? record.hint : undefined,
    encryptionAvailable,
    storage: 'safeStorage',
  };
}

export function saveToken(api: PluginAPI, token: TokenRecord): void {
  api.config.setPluginData('encryptedToken', encryptRecord(api, token));
}

export function loadToken(api: PluginAPI): TokenRecord | null {
  return decryptRecord<TokenRecord>(api, api.config.getPluginData().encryptedToken);
}

export function clearToken(api: PluginAPI): void {
  api.config.setPluginData('encryptedToken', null);
}
