import { randomBytes } from 'node:crypto';
import {
  AUTH_PARTITION,
  DEFAULT_BASE_URL,
  DEFAULT_LOGIN_URL,
  OAUTH_SCOPE,
  REDIRECT_URI,
} from '../shared/constants.js';
import type { AuthState, PluginAPI, TokenRecord } from '../shared/types.js';
import { clearToken, loadCredentials, loadToken, saveToken } from './secure-store.js';

type AuthWindowHelpers = {
  executeJavaScript: (code: string) => Promise<unknown>;
  getURL: () => string;
  onDidNavigate: (callback: (url: string) => void) => void;
  show: () => void;
};

function normalizeBaseUrl(raw: unknown): string {
  const candidate = typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_BASE_URL;
  const withScheme = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
  const url = new URL(withScheme);
  if (url.protocol !== 'https:') throw new Error('Rally base URL must use HTTPS.');
  return url.toString().replace(/\/$/, '');
}

export function configuredBaseUrl(api: PluginAPI): string {
  return normalizeBaseUrl(api.config.getPluginData().baseUrl);
}

export function configuredLoginUrl(api: PluginAPI): string {
  const config = api.config.getPluginData();
  const value = typeof config.loginUrl === 'string' && config.loginUrl.trim()
    ? config.loginUrl
    : typeof config.ssoStartUrl === 'string' && config.ssoStartUrl.trim()
      ? config.ssoStartUrl
      : DEFAULT_LOGIN_URL;
  const url = new URL(value.trim());
  if (url.protocol !== 'https:') throw new Error('The Rally Login URL must use HTTPS.');
  return url.toString();
}

function sameOriginUrl(baseUrl: string, path: string): URL {
  const base = new URL(`${baseUrl}/`);
  const url = new URL(path, base);
  if (url.origin !== base.origin) throw new Error(`Refusing OAuth request to another origin: ${url.origin}`);
  return url;
}

function authorizeUrl(baseUrl: string, clientId: string, state: string): string {
  const url = sameOriginUrl(baseUrl, '/login/oauth2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', OAUTH_SCOPE);
  url.searchParams.set('state', state);
  return url.toString();
}

export function shouldAdvanceFromLogin(
  currentUrl: string,
  baseUrl: string,
  loginUrl: string,
): boolean {
  let current: URL;
  try {
    current = new URL(currentUrl);
  } catch {
    return false;
  }
  const rally = new URL(baseUrl);
  if (current.origin !== rally.origin) return false;
  if (current.toString() === new URL(loginUrl).toString()) return false;
  const path = current.pathname.toLowerCase();
  const stillAuthenticating = [
    '/login', '/oauth', '/sso', '/saml', '/j_sso', '/security_check',
  ].some((marker) => path.includes(marker));
  return !stillAuthenticating;
}

async function exchangeCode(
  api: PluginAPI,
  baseUrl: string,
  clientId: string,
  clientSecret: string,
  code: string,
): Promise<TokenRecord> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
    code,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const response = await api.fetch(sameOriginUrl(baseUrl, '/login/oauth2/token'), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });
  const text = await response.text();
  let payload: Record<string, unknown>;
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`Rally OAuth returned a non-JSON response (${response.status}).`);
  }
  if (!response.ok || typeof payload.access_token !== 'string') {
    const detail = payload.error_description ?? payload.error ?? `HTTP ${response.status}`;
    throw new Error(`Rally OAuth code exchange failed: ${String(detail)}`);
  }
  const createdAt = new Date();
  const expiresIn = Number(payload.expires_in);
  return {
    accessToken: payload.access_token,
    baseUrl,
    createdAt: createdAt.toISOString(),
    expiresAt: Number.isFinite(expiresIn)
      ? new Date(createdAt.getTime() + expiresIn * 1000).toISOString()
      : undefined,
    scope: typeof payload.scope === 'string' ? payload.scope : OAUTH_SCOPE,
    tokenType: typeof payload.token_type === 'string' ? payload.token_type : undefined,
  };
}

export async function signIn(api: PluginAPI): Promise<TokenRecord> {
  const credentials = loadCredentials(api);
  if (!credentials) throw new Error('Save a Rally OAuth Client ID and secret before authorizing Kai.');

  const baseUrl = configuredBaseUrl(api);
  const loginUrl = configuredLoginUrl(api);
  const state = randomBytes(24).toString('base64url');
  const oauthUrl = authorizeUrl(baseUrl, credentials.clientId, state);
  let oauthStarted = false;
  const result = await api.auth.openAuthWindow({
    url: loginUrl,
    callbackMatch: REDIRECT_URI,
    extractParams: ['code', 'state', 'error', 'error_description'],
    title: 'Rally — Authorize Kai',
    width: 860,
    height: 760,
    timeoutMs: 300_000,
    partition: AUTH_PARTITION,
    customUserAgent: false,
    successMessage: 'Kai is authorized for Rally. You may close this window.',
    onReady: (helpers: AuthWindowHelpers) => {
      helpers.onDidNavigate((currentUrl) => {
        if (oauthStarted || !shouldAdvanceFromLogin(currentUrl, baseUrl, loginUrl)) return;
        oauthStarted = true;
        void helpers.executeJavaScript(
          `window.location.replace(${JSON.stringify(oauthUrl)});`,
        ).catch((error) => {
          api.log.warn(`Could not continue from Rally login to authorization: ${error instanceof Error ? error.message : String(error)}`);
          helpers.show();
        });
      });
    },
  });

  if (!result.success) throw new Error(result.error || 'Rally authorization was cancelled.');
  if (result.params?.error) {
    throw new Error(result.params.error_description || result.params.error);
  }
  if (result.params?.state !== state) throw new Error('Rally OAuth state validation failed.');
  const code = result.params?.code;
  if (!code) throw new Error('Rally did not return an authorization code.');

  const token = await exchangeCode(
    api,
    baseUrl,
    credentials.clientId,
    credentials.clientSecret,
    code,
  );
  saveToken(api, token);
  return token;
}

export function currentToken(api: PluginAPI): TokenRecord | null {
  const token = loadToken(api);
  if (!token) return null;
  if (token.expiresAt && Date.parse(token.expiresAt) <= Date.now()) return null;
  return token;
}

export function authState(api: PluginAPI, verified = false, error?: string): AuthState {
  let token: TokenRecord | null = null;
  try {
    token = loadToken(api);
  } catch (storageError) {
    return {
      authenticated: false,
      verified: false,
      error: storageError instanceof Error ? storageError.message : String(storageError),
    };
  }
  const expired = Boolean(token?.expiresAt && Date.parse(token.expiresAt) <= Date.now());
  return {
    authenticated: Boolean(token && !expired),
    verified: Boolean(token && !expired && verified),
    createdAt: token?.createdAt,
    expiresAt: token?.expiresAt,
    scope: token?.scope,
    error: error ?? (expired ? 'The Rally access token has expired. Authorize Kai again.' : undefined),
  };
}

export async function signOut(api: PluginAPI, localOnly = false): Promise<void> {
  const token = loadToken(api);
  if (token && !localOnly) {
    const response = await api.fetch(
      sameOriginUrl(token.baseUrl, `/login/key/${encodeURIComponent(token.accessToken)}`),
      {
        method: 'DELETE',
        headers: { Accept: 'application/json', ZSESSIONID: token.accessToken },
      },
    );
    if (!response.ok) {
      throw new Error(`Failed to revoke the Rally token (${response.status} ${response.statusText}).`);
    }
  }
  clearToken(api);
}
