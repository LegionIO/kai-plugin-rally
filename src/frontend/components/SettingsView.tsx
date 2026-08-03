import React, { useState } from 'react';
import { DEFAULT_BASE_URL, DEFAULT_LOGIN_URL, REDIRECT_URI } from '../../shared/constants.js';
import type { PluginComponentProps, ToolPermissions } from '../../shared/types.js';

export function SettingsView({ pluginState, pluginConfig, onAction }: PluginComponentProps) {
  const credentials = pluginState?.credentials;
  const auth = pluginState?.auth;
  const currentPermissions = pluginState?.toolPermissions ?? {
    read: true,
    write: false,
    delete: false,
    rawRequest: false,
  };
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [baseUrl, setBaseUrl] = useState(
    typeof pluginConfig?.baseUrl === 'string' ? pluginConfig.baseUrl : DEFAULT_BASE_URL,
  );
  const [loginUrl, setLoginUrl] = useState(
    typeof pluginConfig?.loginUrl === 'string' && pluginConfig.loginUrl.trim()
      ? pluginConfig.loginUrl
      : typeof pluginConfig?.ssoStartUrl === 'string' && pluginConfig.ssoStartUrl.trim()
        ? pluginConfig.ssoStartUrl
        : DEFAULT_LOGIN_URL,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const configuredSync = pluginConfig?.sync && typeof pluginConfig.sync === 'object'
    ? pluginConfig.sync as Record<string, unknown>
    : {};
  const configuredTaskBoard = configuredSync.taskBoard && typeof configuredSync.taskBoard === 'object'
    ? configuredSync.taskBoard as Record<string, unknown>
    : {};
  const [syncEnabled, setSyncEnabled] = useState(configuredSync.enabled === true);
  const [syncInterval, setSyncInterval] = useState(Number(configuredSync.intervalSeconds) || 300);
  const [syncNotifications, setSyncNotifications] = useState(configuredSync.notifications !== false);
  const [notifyOnNew, setNotifyOnNew] = useState(configuredSync.notifyOnNew !== false);
  const [notifyOnUpdated, setNotifyOnUpdated] = useState(configuredSync.notifyOnUpdated !== false);
  const [maxSyncItems, setMaxSyncItems] = useState(Number(configuredSync.maxItemsPerWatch) || 200);
  const [taskBoardEnabled, setTaskBoardEnabled] = useState(configuredTaskBoard.enabled === true);
  const [taskBoardBidirectional, setTaskBoardBidirectional] = useState(configuredTaskBoard.bidirectional !== false);
  const [taskBoardArchiveMissing, setTaskBoardArchiveMissing] = useState(configuredTaskBoard.archiveMissing !== false);

  const invoke = async (action: string, data?: unknown) => {
    setBusy(action);
    setNotice(null);
    try {
      const result = await Promise.resolve(onAction(action, data));
      return result;
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      setBusy(null);
    }
  };

  const saveCredentials = async () => {
    if (!clientId.trim() || !clientSecret.trim()) return;
    const result = await invoke('save-credentials', { clientId, clientSecret, baseUrl, loginUrl });
    if (result) {
      setClientId('');
      setClientSecret('');
      setNotice({ kind: 'success', text: 'OAuth client saved with OS-protected encryption.' });
    }
  };

  const updatePermission = (key: keyof ToolPermissions, value: boolean) => {
    void invoke('save-tool-permissions', { [key]: value });
  };

  const saveSyncSettings = async () => {
    const result = await invoke('save-sync-settings', {
      enabled: syncEnabled,
      intervalSeconds: syncInterval,
      notifications: syncNotifications,
      notifyOnNew,
      notifyOnUpdated,
      maxItemsPerWatch: maxSyncItems,
      taskBoardEnabled,
      taskBoardBidirectional,
      taskBoardArchiveMissing,
    });
    if (result) setNotice({ kind: 'success', text: 'Background Rally synchronization settings saved.' });
  };

  const authorizeKai = async () => {
    setBusy('login');
    setNotice(null);
    try {
      await Promise.resolve(onAction('save-login-url', { loginUrl }));
      await Promise.resolve(onAction('login'));
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold">Rally</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          OAuth-secured Broadcom Rally access for work-item search, management, and AI tools.
        </p>
      </div>

      {notice && (
        <div className={`rounded-lg border px-3 py-2 text-xs ${notice.kind === 'success' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600' : 'border-destructive/30 bg-destructive/10 text-destructive'}`}>
          {notice.text}
        </div>
      )}

      <fieldset className="space-y-3 rounded-xl border border-border/60 p-4">
        <legend className="px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">1. Create an OAuth client</legend>
        <ol className="list-decimal space-y-2 pl-5 text-xs text-muted-foreground">
          <li>Sign in to Rally in a normal browser. If your organization uses SSO, use its Rally login URL.</li>
          <li>Open your profile avatar, then choose <strong className="text-foreground">My Settings → Access → OAuth Clients</strong>.</li>
          <li>Click <strong className="text-foreground">Create</strong>. OAuth Client page URLs can contain user- or context-specific IDs, so this plugin intentionally does not link one.</li>
          <li>Use a recognizable name such as <code className="text-foreground">Kai Desktop</code>.</li>
          <li>
            Set Callback URL to exactly:
            <code className="mt-1 block select-all rounded-md bg-muted px-2 py-1.5 text-[11px] text-foreground">{REDIRECT_URI}</code>
          </li>
          <li>Save, then copy the generated Client ID and Secret Key below.</li>
        </ol>
      </fieldset>

      <fieldset className="space-y-3 rounded-xl border border-border/60 p-4">
        <legend className="px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">2. Store credentials securely</legend>
        <div className="rounded-lg bg-muted/40 p-3 text-xs">
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Storage</span>
            <span className={credentials?.encryptionAvailable ? 'text-emerald-600' : 'text-destructive'}>
              {credentials?.encryptionAvailable ? 'OS safeStorage available' : 'OS safeStorage unavailable'}
            </span>
          </div>
          <div className="mt-1 flex justify-between gap-3">
            <span className="text-muted-foreground">OAuth client</span>
            <span>{credentials?.configured ? credentials.clientIdHint ?? 'Configured' : 'Not configured'}</span>
          </div>
        </div>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Rally URL</span>
          <input
            type="url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none focus:ring-1 focus:ring-ring"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Rally Login URL</span>
          <input
            type="url"
            value={loginUrl}
            onChange={(event) => setLoginUrl(event.target.value)}
            placeholder={DEFAULT_LOGIN_URL}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none focus:ring-1 focus:ring-ring"
          />
          <span className="block text-[11px] text-muted-foreground">
            Kai opens this URL inside the same isolated window used for OAuth, then continues to Rally authorization after sign-in completes. Replace the default if your organization provides a different login URL.
          </span>
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Client ID</span>
          <input
            type="text"
            autoComplete="off"
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            placeholder={credentials?.configured ? 'Enter both values to replace the saved client' : 'OAuth Client ID'}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none focus:ring-1 focus:ring-ring"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Client secret</span>
          <input
            type="password"
            autoComplete="new-password"
            value={clientSecret}
            onChange={(event) => setClientSecret(event.target.value)}
            placeholder={credentials?.configured ? '••••••••••••••••' : 'Secret Key'}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none focus:ring-1 focus:ring-ring"
          />
        </label>
        <p className="text-[11px] text-muted-foreground">
          Both values are encrypted together using Electron safeStorage. Plaintext credentials are never written to plugin config, logs, or build output.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!credentials?.encryptionAvailable || !clientId.trim() || !clientSecret.trim() || busy === 'save-credentials'}
            onClick={() => void saveCredentials()}
            className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy === 'save-credentials' ? 'Encrypting…' : credentials?.configured ? 'Replace OAuth client' : 'Save OAuth client'}
          </button>
          {credentials?.configured && (
            <button
              type="button"
              onClick={() => void invoke('clear-credentials')}
              className="rounded-lg border border-destructive/40 px-3 py-2 text-xs font-medium text-destructive hover:bg-destructive/10"
            >
              Remove credentials
            </button>
          )}
          <button
            type="button"
            disabled={busy === 'save-login-url'}
            onClick={() => void invoke('save-login-url', { loginUrl })}
            className="rounded-lg border border-border px-3 py-2 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            {busy === 'save-login-url' ? 'Saving…' : 'Save Rally Login URL'}
          </button>
        </div>
      </fieldset>

      <fieldset className="space-y-3 rounded-xl border border-border/60 p-4">
        <legend className="px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">3. Authorize Kai</legend>
        <p className="text-xs text-muted-foreground">
          The Client ID and secret identify Kai as the OAuth application; they do not identify you. Rally may still require interactive sign-in and consent. Kai performs both in one authorization window.
        </p>
        <div className="rounded-lg bg-muted/40 p-3 text-xs">
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Status</span>
            <span className={auth?.authenticated ? 'text-emerald-600' : 'text-muted-foreground'}>
              {auth?.authenticated ? auth.verified ? 'Authorized and verified' : 'OAuth token stored' : 'Not authorized'}
            </span>
          </div>
          {auth?.expiresAt && (
            <div className="mt-1 flex justify-between gap-3">
              <span className="text-muted-foreground">Expires</span>
              <span>{new Date(auth.expiresAt).toLocaleString()}</span>
            </div>
          )}
          {auth?.error && <p className="mt-2 text-destructive">{auth.error}</p>}
        </div>
        {auth?.authenticated ? (
          <button
            type="button"
            onClick={() => void invoke('logout')}
            disabled={busy === 'logout'}
            className="rounded-lg border border-border px-3 py-2 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            {busy === 'logout' ? 'Revoking…' : 'Revoke Kai authorization'}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void authorizeKai()}
            disabled={!credentials?.configured || !loginUrl.trim() || busy === 'login'}
            className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy === 'login' ? 'Waiting for Rally sign-in…' : 'Authorize Kai with Rally'}
          </button>
        )}
      </fieldset>

      <fieldset className="space-y-3 rounded-xl border border-border/60 p-4">
        <legend className="px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Background synchronization</legend>
        <p className="text-xs text-muted-foreground">
          Poll saved Rally watch queries for new and changed work, publish plugin events, and optionally show notifications. Watch queries can be managed with the <code className="text-foreground">rally_manage_sync</code> AI tool.
        </p>
        <label className="flex items-start gap-3 rounded-lg border border-border/60 bg-card/40 p-3">
          <input type="checkbox" checked={syncEnabled} onChange={(event) => setSyncEnabled(event.target.checked)} className="mt-0.5 h-4 w-4" />
          <span><span className="block text-xs font-medium">Enable polling</span><span className="text-[11px] text-muted-foreground">Runs only while Kai Desktop and this plugin are active.</span></span>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>Poll interval (seconds, minimum 30)</span>
            <input type="number" min={30} value={syncInterval} onChange={(event) => setSyncInterval(Number(event.target.value) || 300)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground" />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>Maximum items per watch</span>
            <input type="number" min={1} max={1000} value={maxSyncItems} onChange={(event) => setMaxSyncItems(Number(event.target.value) || 200)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground" />
          </label>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={syncNotifications} onChange={(event) => setSyncNotifications(event.target.checked)} /> Notifications</label>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={notifyOnNew} onChange={(event) => setNotifyOnNew(event.target.checked)} /> New items</label>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={notifyOnUpdated} onChange={(event) => setNotifyOnUpdated(event.target.checked)} /> Updated items</label>
        </div>
        <div className="space-y-2 rounded-lg border border-border/60 bg-card/40 p-3">
          <label className="flex items-start gap-3">
            <input type="checkbox" checked={taskBoardEnabled} onChange={(event) => setTaskBoardEnabled(event.target.checked)} className="mt-0.5 h-4 w-4" />
            <span>
              <span className="block text-xs font-medium">Mirror watches to Kai Tasks</span>
              <span className="text-[11px] text-muted-foreground">Each work item matched by an enabled watch becomes one idempotently linked Kanban card in the current Kai workspace.</span>
            </span>
          </label>
          <label className="flex items-start gap-3 pl-7">
            <input type="checkbox" checked={taskBoardBidirectional} disabled={!taskBoardEnabled} onChange={(event) => setTaskBoardBidirectional(event.target.checked)} className="mt-0.5 h-4 w-4" />
            <span>
              <span className="block text-xs font-medium">Push card edits to Rally</span>
              <span className="text-[11px] text-muted-foreground">Synchronizes title, description, and compatible status changes with LastUpdateDate conflict checks.</span>
            </span>
          </label>
          <label className="flex items-start gap-3 pl-7">
            <input type="checkbox" checked={taskBoardArchiveMissing} disabled={!taskBoardEnabled} onChange={(event) => setTaskBoardArchiveMissing(event.target.checked)} className="mt-0.5 h-4 w-4" />
            <span>
              <span className="block text-xs font-medium">Archive cards that leave all watches</span>
              <span className="text-[11px] text-muted-foreground">Only applies after complete watch results. Manually archived or deleted cards stay dismissed.</span>
            </span>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void saveSyncSettings()} disabled={busy === 'save-sync-settings'} className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50">
            {busy === 'save-sync-settings' ? 'Saving…' : 'Save sync settings'}
          </button>
          {auth?.authenticated && (
            <button type="button" onClick={() => void invoke('sync-now')} disabled={busy === 'sync-now' || pluginState?.sync.running} className="rounded-lg border border-border px-3 py-2 text-xs font-medium hover:bg-muted disabled:opacity-50">
              {busy === 'sync-now' || pluginState?.sync.running ? 'Syncing…' : 'Run watches now'}
            </button>
          )}
          <span className="text-[11px] text-muted-foreground">
            {pluginState?.sync.lastCompletedAt ? `Last completed ${new Date(pluginState.sync.lastCompletedAt).toLocaleString()}` : 'No completed sync yet'}
          </span>
        </div>
        {pluginState?.sync.error && <p className="text-xs text-destructive">{pluginState.sync.error}</p>}
        {pluginState?.sync.taskBoard && (
          <p className="text-[11px] text-muted-foreground">
            Last board sync: {pluginState.sync.taskBoard.created} added, {pluginState.sync.taskBoard.updated} updated, {pluginState.sync.taskBoard.archived} archived, {pluginState.sync.taskBoard.unchanged} unchanged.
          </p>
        )}
      </fieldset>

      <fieldset className="space-y-3 rounded-xl border border-border/60 p-4">
        <legend className="px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">AI tool permissions</legend>
        <p className="text-xs text-muted-foreground">
          Read tools are enabled by default. Mutating, destructive, and raw tools are opt-in; every mutation also requires a confirmed=true argument after explicit user confirmation.
        </p>
        {([
          ['read', 'Read tools', 'Search work items and list workspaces/projects.'],
          ['write', 'Write tools', 'Create/update/move items, planning, capacity, discussions, tags, attachments, dependencies, and sync watches.'],
          ['rawRequest', 'Raw WSAPI tool', 'Call arbitrary same-origin WSAPI endpoints.'],
          ['delete', 'Delete tools', 'Permanently delete Rally objects, attachments, and discussion posts; cannot be undone.'],
        ] as Array<[keyof ToolPermissions, string, string]>).map(([key, label, description]) => (
          <label key={key} className="flex items-start gap-3 rounded-lg border border-border/60 bg-card/40 p-3">
            <input
              type="checkbox"
              checked={Boolean(currentPermissions[key])}
              onChange={(event) => updatePermission(key, event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-border"
            />
            <span>
              <span className="block text-xs font-medium">{label}</span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">{description}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}
