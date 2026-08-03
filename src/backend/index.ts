import {
  DEFAULT_BASE_URL,
  DEFAULT_LOGIN_URL,
  DEFAULT_SEARCH_ORDER,
  DEFAULT_TOOL_PERMISSIONS,
  NAV_ID,
  PANEL_ID,
  SETTINGS_ID,
} from '../shared/constants.js';
import type {
  PluginAPI,
  ProjectOption,
  RallyContext,
  RallyPluginState,
  ToolPermissions,
  WorkspaceOption,
} from '../shared/types.js';
import { authState, configuredBaseUrl, currentToken, signIn, signOut } from './oauth.js';
import { RallyClient } from './rally-client.js';
import {
  clearCredentials,
  clearToken,
  credentialState,
  saveCredentials,
} from './secure-store.js';
import { ALL_TOOL_NAMES, registerTools } from './tools.js';
import { RallySyncManager, syncSettings } from './sync.js';

let disposeConfigListener: (() => void) | null = null;
let syncManager: RallySyncManager | null = null;

function context(api: PluginAPI): RallyContext {
  const value = api.config.getPluginData().context;
  return value && typeof value === 'object' ? value as RallyContext : {};
}

function toolPermissions(api: PluginAPI): ToolPermissions {
  const configured = api.config.getPluginData().toolPermissions;
  return {
    ...DEFAULT_TOOL_PERMISSIONS,
    ...(configured && typeof configured === 'object' ? configured as Partial<ToolPermissions> : {}),
  };
}

function client(api: PluginAPI): RallyClient {
  const token = currentToken(api);
  if (!token) throw new Error('Rally authorization is required. Open Rally settings and authorize Kai.');
  return new RallyClient(api, token, context(api));
}

function authSnapshot(api: PluginAPI): Record<string, unknown> {
  return {
    credentials: credentialState(api),
    auth: authState(api),
    context: context(api),
  };
}

function initialState(api: PluginAPI): RallyPluginState {
  return {
    credentials: credentialState(api),
    auth: authState(api),
    context: context(api),
    workspaces: [],
    projects: [],
    results: [],
    selectedItem: null,
    selectedDetails: null,
    searchPage: {
      page: 1,
      pageSize: 50,
      total: 0,
      hasMore: false,
      order: DEFAULT_SEARCH_ORDER,
    },
    sync: syncManager?.getStatus() ?? { running: false, changes: [], conflicts: [] },
    toolPermissions: toolPermissions(api),
    loading: {},
    error: null,
  };
}

function setLoading(api: PluginAPI, key: string, value: boolean): void {
  api.state.set(`loading.${key}`, value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notify(api: PluginAPI, id: string, title: string, level: string, body?: string): void {
  api.notifications.show({ id, title, body, level, autoDismissMs: level === 'error' ? 6000 : 3500 });
}

function publishSecurityState(api: PluginAPI, verified = false, error?: string): void {
  api.state.set('credentials', credentialState(api));
  api.state.set('auth', authState(api, verified, error));
}

async function verifyAuthentication(api: PluginAPI): Promise<boolean> {
  try {
    await client(api).verify();
    publishSecurityState(api, true);
    return true;
  } catch (error) {
    publishSecurityState(api, false, message(error));
    return false;
  }
}

async function refreshContext(api: PluginAPI): Promise<void> {
  setLoading(api, 'context', true);
  api.state.set('error', null);
  try {
    const rally = client(api);
    const workspaces = await rally.listWorkspaces();
    api.state.set('workspaces', workspaces);
    const selected = context(api);
    let projects: ProjectOption[] = [];
    if (selected.workspaceRef) {
      projects = await rally.listProjects(selected.workspaceRef);
    }
    api.state.set('projects', projects);
  } catch (error) {
    api.state.set('error', message(error));
    throw error;
  } finally {
    setLoading(api, 'context', false);
  }
}

function saveContext(api: PluginAPI, next: RallyContext): void {
  api.config.setPluginData('context', next);
  api.state.set('context', next);
}

function findWorkspace(api: PluginAPI, ref: string): WorkspaceOption | undefined {
  const values = (api.state.get().workspaces ?? []) as WorkspaceOption[];
  return values.find((item) => item.ref === ref);
}

function findProject(api: PluginAPI, ref: string): ProjectOption | undefined {
  const values = (api.state.get().projects ?? []) as ProjectOption[];
  return values.find((item) => item.ref === ref);
}

async function login(api: PluginAPI): Promise<void> {
  setLoading(api, 'auth', true);
  api.state.set('error', null);
  try {
    await signIn(api);
    const verified = await verifyAuthentication(api);
    if (!verified) throw new Error('Rally issued a token, but WSAPI verification failed.');
    await refreshContext(api);
    syncManager?.start();
    if (syncSettings(api).enabled) void syncManager?.runNow('activation');
    notify(api, 'rally-signed-in', 'Signed in to Rally', 'success');
  } catch (error) {
    const detail = message(error);
    publishSecurityState(api, false, detail);
    api.state.set('error', detail);
    notify(api, 'rally-sign-in-failed', 'Rally sign-in failed', 'error', detail);
    throw error;
  } finally {
    setLoading(api, 'auth', false);
  }
}

async function logout(api: PluginAPI, localOnly = false): Promise<void> {
  setLoading(api, 'auth', true);
  try {
    await signOut(api, localOnly);
    syncManager?.stop();
    publishSecurityState(api);
    api.state.set('workspaces', []);
    api.state.set('projects', []);
    api.state.set('results', []);
    api.state.set('selectedItem', null);
    api.state.set('selectedDetails', null);
    notify(api, 'rally-signed-out', 'Signed out of Rally', 'info');
  } finally {
    setLoading(api, 'auth', false);
  }
}

async function panelAction(api: PluginAPI, action: string, input?: unknown): Promise<unknown> {
  const data = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  switch (action) {
    case 'login':
      await login(api);
      return { success: true };
    case 'logout':
      await logout(api);
      return { success: true };
    case 'refresh-context':
      await refreshContext(api);
      return { success: true };
    case 'select-workspace': {
      const ref = String(data.ref ?? '');
      const workspace = findWorkspace(api, ref);
      saveContext(api, {
        workspaceRef: ref || undefined,
        workspaceName: workspace?.name,
      });
      api.state.set('projects', []);
      api.state.set('results', []);
      api.state.set('selectedItem', null);
      api.state.set('selectedDetails', null);
      if (ref) {
        const projects = await client(api).listProjects(ref);
        api.state.set('projects', projects);
      }
      return { success: true };
    }
    case 'select-project': {
      const ref = String(data.ref ?? '');
      const project = findProject(api, ref);
      saveContext(api, {
        ...context(api),
        projectRef: ref || undefined,
        projectName: project?.name,
      });
      api.state.set('results', []);
      api.state.set('selectedItem', null);
      api.state.set('selectedDetails', null);
      return { success: true };
    }
    case 'search': {
      const search = String(data.search ?? '').trim();
      if (!search) throw new Error('Enter a FormattedID, title text, or WSAPI query.');
      const query = search.startsWith('(')
        ? search
        : /^(US|DE|F|C|TA|TC)\d+$/i.test(search)
          ? `(FormattedID = "${search.toUpperCase()}")`
          : `(Name contains "${search.replace(/"/g, '\\"')}")`;
      setLoading(api, 'search', true);
      api.state.set('error', null);
      try {
        const result = await client(api).searchWorkItemsPage(query, {
          projects: Array.isArray(data.projects) ? data.projects.map(String) : undefined,
          types: Array.isArray(data.types) ? data.types.map(String) : undefined,
          page: typeof data.page === 'number' ? data.page : 1,
          pageSize: typeof data.pageSize === 'number' ? data.pageSize : 50,
          order: typeof data.order === 'string' ? data.order : DEFAULT_SEARCH_ORDER,
          projectScopeUp: data.projectScopeUp === true,
          projectScopeDown: data.projectScopeDown === true,
        });
        api.state.set('results', result.items);
        api.state.set('searchPage', {
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
          hasMore: result.hasMore,
          order: result.order ?? DEFAULT_SEARCH_ORDER,
        });
        api.state.set('selectedItem', result.items.length === 1 ? result.items[0] : null);
        api.state.set('selectedDetails', null);
        return result;
      } catch (error) {
        api.state.set('error', message(error));
        throw error;
      } finally {
        setLoading(api, 'search', false);
      }
    }
    case 'select-item': {
      const formattedId = String(data.formattedId ?? '');
      setLoading(api, 'item', true);
      try {
        const rally = client(api);
        const item = await rally.getWorkItem(formattedId);
        api.state.set('selectedItem', item);
        const [collections, relationships] = await Promise.all([
          rally.getWorkItemCollections(formattedId, { pageSize: 50, order: 'CreationDate DESC' }),
          rally.getRelationships(formattedId, { pageSize: 50 }),
        ]);
        api.state.set('selectedDetails', { collections, relationships });
        return item;
      } finally {
        setLoading(api, 'item', false);
      }
    }
    case 'open-item': {
      const url = String(data.url ?? '');
      if (!url.startsWith(`${configuredBaseUrl(api)}/`)) throw new Error('Invalid Rally item URL.');
      await api.shell.openExternal(url);
      return { success: true };
    }
    case 'add-to-task-board': {
      if (!syncManager) throw new Error('Rally task-board synchronization is not initialized.');
      const formattedId = String(data.formattedId ?? '').trim().toUpperCase();
      if (!formattedId) throw new Error('A Rally FormattedID is required.');
      setLoading(api, 'taskBoard', true);
      try {
        const result = await syncManager.importToTaskBoard([formattedId]);
        notify(
          api,
          `rally-task-import-${formattedId}`,
          result.created ? `${formattedId} added to Tasks` : `${formattedId} refreshed in Tasks`,
          'success',
        );
        return result;
      } finally {
        setLoading(api, 'taskBoard', false);
      }
    }
    case 'sync-now':
      if (!syncManager) throw new Error('Rally sync is not initialized.');
      return syncManager.runNow('manual');
    default:
      throw new Error(`Unknown Rally panel action: ${action}`);
  }
}

async function settingsAction(api: PluginAPI, action: string, input?: unknown): Promise<unknown> {
  const data = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  switch (action) {
    case 'save-credentials': {
      const baseUrl = String(data.baseUrl ?? DEFAULT_BASE_URL).trim();
      const normalized = new URL(/^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`);
      if (normalized.protocol !== 'https:') throw new Error('Rally base URL must use HTTPS.');
      const loginUrl = String(data.loginUrl ?? DEFAULT_LOGIN_URL).trim() || DEFAULT_LOGIN_URL;
      const normalizedLoginUrl = new URL(loginUrl);
      if (normalizedLoginUrl.protocol !== 'https:') throw new Error('The Rally Login URL must use HTTPS.');
      saveCredentials(api, {
        clientId: String(data.clientId ?? ''),
        clientSecret: String(data.clientSecret ?? ''),
      });
      api.config.setPluginData('baseUrl', normalized.toString().replace(/\/$/, ''));
      api.config.setPluginData('loginUrl', normalizedLoginUrl.toString());
      api.config.setPluginData('ssoStartUrl', '');
      clearToken(api);
      publishSecurityState(api);
      notify(api, 'rally-credentials-saved', 'Rally OAuth client saved', 'success', 'Protected by OS safeStorage.');
      return { success: true };
    }
    case 'clear-credentials':
      clearCredentials(api);
      clearToken(api);
      syncManager?.stop();
      publishSecurityState(api);
      notify(api, 'rally-credentials-cleared', 'Rally OAuth client removed', 'info');
      return { success: true };
    case 'login':
      await login(api);
      return { success: true };
    case 'logout':
      await logout(api);
      return { success: true };
    case 'save-login-url': {
      const value = String(data.loginUrl ?? DEFAULT_LOGIN_URL).trim() || DEFAULT_LOGIN_URL;
      const url = new URL(value);
      if (url.protocol !== 'https:') throw new Error('The Rally Login URL must use HTTPS.');
      api.config.setPluginData('loginUrl', url.toString());
      api.config.setPluginData('ssoStartUrl', '');
      return { success: true };
    }
    case 'save-tool-permissions': {
      const next = { ...toolPermissions(api), ...data } as ToolPermissions;
      api.config.setPluginData('toolPermissions', next);
      api.state.set('toolPermissions', next);
      registerTools({
        api,
        getClient: () => client(api),
        authStatus: () => authSnapshot(api),
        sync: syncManager!,
      }, next);
      return { success: true };
    }
    case 'save-sync-settings': {
      if (!syncManager) throw new Error('Rally sync is not initialized.');
      const next = syncManager.saveSettings({
        enabled: data.enabled === true,
        intervalSeconds: Number(data.intervalSeconds),
        notifications: data.notifications !== false,
        notifyOnNew: data.notifyOnNew !== false,
        notifyOnUpdated: data.notifyOnUpdated !== false,
        maxItemsPerWatch: Number(data.maxItemsPerWatch),
        taskBoard: {
          enabled: data.taskBoardEnabled === true,
          bidirectional: data.taskBoardBidirectional !== false,
          archiveMissing: data.taskBoardArchiveMissing !== false,
        },
      });
      return { success: true, sync: next };
    }
    case 'sync-now':
      if (!syncManager) throw new Error('Rally sync is not initialized.');
      return syncManager.runNow('manual');
    default:
      throw new Error(`Unknown Rally settings action: ${action}`);
  }
}

function actionHandler(
  api: PluginAPI,
  handler: (api: PluginAPI, action: string, input?: unknown) => Promise<unknown>,
): (action: string, input?: unknown) => Promise<unknown> {
  return async (action, input) => {
    try {
      return await handler(api, action, input);
    } catch (error) {
      api.log.warn(`Rally action ${action} failed: ${message(error)}`);
      throw error;
    }
  };
}

export async function activate(api: PluginAPI): Promise<void> {
  api.log.info('Activating Rally plugin.');
  api.ui.registerPanelView({
    id: PANEL_ID,
    title: 'Rally',
    visible: true,
    width: 'full',
  });
  api.ui.registerNavigationItem({
    id: NAV_ID,
    label: 'Rally',
    icon: { lucide: 'clipboard-list' },
    visible: true,
    target: { type: 'panel', panelId: PANEL_ID },
  });
  api.ui.registerSettingsView({
    id: SETTINGS_ID,
    label: 'Rally',
  });

  api.onAction(`panel:${PANEL_ID}`, actionHandler(api, panelAction));
  api.onAction('settings:SettingsView', actionHandler(api, settingsAction));
  api.onAction('settings:RallySettings', actionHandler(api, settingsAction));

  syncManager?.stop();
  syncManager = new RallySyncManager(api, () => client(api));
  api.state.replace(initialState(api) as unknown as Record<string, unknown>);
  const permissions = toolPermissions(api);
  registerTools({
    api,
    getClient: () => client(api),
    authStatus: () => authSnapshot(api),
    sync: syncManager,
  }, permissions);

  disposeConfigListener?.();
  disposeConfigListener = api.config.onChanged(() => {
    const nextPermissions = toolPermissions(api);
    api.state.set('context', context(api));
    api.state.set('toolPermissions', nextPermissions);
    publishSecurityState(api);
    syncManager?.reconfigure();
  });

  if (currentToken(api)) {
    const verified = await verifyAuthentication(api);
    if (verified) {
      try {
        await refreshContext(api);
      } catch (error) {
        api.log.warn(`Could not load Rally context during activation: ${message(error)}`);
      }
      syncManager.start();
      if (syncSettings(api).enabled) void syncManager.runNow('activation');
    }
  }
}

export function deactivate(api: PluginAPI): void {
  disposeConfigListener?.();
  disposeConfigListener = null;
  syncManager?.stop();
  syncManager = null;
  api.tools.unregister([...ALL_TOOL_NAMES]);
}
