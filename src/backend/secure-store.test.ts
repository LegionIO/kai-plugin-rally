import { describe, expect, it } from 'vitest';
import type { PluginAPI } from '../shared/types.js';
import { loadCredentials, saveCredentials } from './secure-store.js';

function mockApi() {
  const data: Record<string, unknown> = {};
  const api = {
    config: {
      getPluginData: () => data,
      setPluginData: (path: string, value: unknown) => { data[path] = value; },
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`sealed:${value}`).toString('base64'),
      decryptString: (value: string) => Buffer.from(value, 'base64').toString().replace(/^sealed:/, ''),
    },
  } as unknown as PluginAPI;
  return { api, data };
}

describe('secure credential storage', () => {
  it('stores no plaintext client credential values', () => {
    const { api, data } = mockApi();
    saveCredentials(api, { clientId: 'client-id-value', clientSecret: 'super-secret-value' });

    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain('client-id-value');
    expect(serialized).not.toContain('super-secret-value');
    expect(loadCredentials(api)).toEqual({
      clientId: 'client-id-value',
      clientSecret: 'super-secret-value',
    });
  });
});
