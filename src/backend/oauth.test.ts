import { describe, expect, it, vi } from 'vitest';
import type { PluginAPI } from '../shared/types.js';
import { configuredLoginUrl, shouldAdvanceFromLogin, signIn } from './oauth.js';

describe('Rally OAuth login bootstrap', () => {
  it('defaults to Rally login and preserves the legacy custom URL during migration', () => {
    const defaultApi = {
      config: { getPluginData: () => ({}) },
    } as unknown as PluginAPI;
    const legacyApi = {
      config: { getPluginData: () => ({ ssoStartUrl: 'https://login.example.test/rally' }) },
    } as unknown as PluginAPI;

    expect(configuredLoginUrl(defaultApi)).toBe('https://rally1.rallydev.com/');
    expect(configuredLoginUrl(legacyApi)).toBe('https://login.example.test/rally');
  });

  it('advances only after login reaches a non-authentication Rally page', () => {
    const baseUrl = 'https://rally1.rallydev.com';
    const startUrl = 'https://sso.example.test/app/rally';

    expect(shouldAdvanceFromLogin(startUrl, baseUrl, startUrl)).toBe(false);
    expect(shouldAdvanceFromLogin('https://login.example.test/saml', baseUrl, startUrl)).toBe(false);
    expect(shouldAdvanceFromLogin('https://rally1.rallydev.com/slm/login.op', baseUrl, startUrl)).toBe(false);
    expect(shouldAdvanceFromLogin('https://rally1.rallydev.com/#/workspace', baseUrl, startUrl)).toBe(true);
  });

  it('opens the configured login URL first and continues to OAuth in the same window', async () => {
    let navigationCallback: ((url: string) => void) | undefined;
    const executeJavaScript = vi.fn(async (_code: string) => undefined);
    const openAuthWindow = vi.fn(async (options: Record<string, unknown>) => {
      expect(options.url).toBe('https://sso.example.test/app/rally');
      expect(options.title).toBe('Rally — Authorize Kai');
      const onReady = options.onReady as (helpers: Record<string, unknown>) => void;
      onReady({
        executeJavaScript,
        getURL: () => '',
        onDidNavigate: (callback: (url: string) => void) => { navigationCallback = callback; },
        show: vi.fn(),
      });
      navigationCallback?.('https://rally1.rallydev.com/#/workspace');
      return { success: false, error: 'cancelled for test' };
    });
    const api = {
      config: {
        getPluginData: () => ({
          baseUrl: 'https://rally1.rallydev.com',
          loginUrl: 'https://sso.example.test/app/rally',
          encryptedCredentials: { version: 1, ciphertext: 'sealed' },
        }),
      },
      safeStorage: {
        isEncryptionAvailable: () => true,
        decryptString: () => JSON.stringify({ clientId: 'client-id', clientSecret: 'client-secret' }),
      },
      auth: { openAuthWindow },
      log: { warn: vi.fn() },
    } as unknown as PluginAPI;

    await expect(signIn(api)).rejects.toThrow('cancelled for test');
    expect(executeJavaScript).toHaveBeenCalledOnce();
    expect(String(executeJavaScript.mock.calls[0][0])).toContain('/login/oauth2/auth');
    expect(String(executeJavaScript.mock.calls[0][0])).toContain('client_id=client-id');
  });
});
