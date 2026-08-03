import { describe, expect, it, vi } from 'vitest';
import type { PluginAPI } from '../shared/types.js';
import { activate, deactivate } from './index.js';

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1)!] = value;
}

describe('plugin activation', () => {
  it('registers the panel, settings, navigation, and default read tools without credentials', async () => {
    const config: Record<string, unknown> = {};
    let state: Record<string, unknown> = {};
    const registeredTools: Array<{ name: string }> = [];
    const panels: Record<string, unknown>[] = [];
    const settings: Record<string, unknown>[] = [];
    const navigation: Record<string, unknown>[] = [];
    const api = {
      pluginName: 'rally',
      pluginDir: '/tmp/rally',
      config: {
        getPluginData: () => config,
        setPluginData: (path: string, value: unknown) => setPath(config, path, value),
        onChanged: () => () => undefined,
      },
      state: {
        get: () => state,
        replace: (next: Record<string, unknown>) => { state = next; },
        set: (path: string, value: unknown) => setPath(state, path, value),
        emitEvent: vi.fn(),
      },
      tools: {
        register: (tools: Array<{ name: string }>) => registeredTools.push(...tools),
        unregister: vi.fn(),
      },
      ui: {
        registerPanelView: (value: Record<string, unknown>) => panels.push(value),
        registerSettingsView: (value: Record<string, unknown>) => settings.push(value),
        registerNavigationItem: (value: Record<string, unknown>) => navigation.push(value),
      },
      notifications: { show: vi.fn(), dismiss: vi.fn() },
      auth: { openAuthWindow: vi.fn() },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: vi.fn(),
        decryptString: vi.fn(),
      },
      shell: { openExternal: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      onAction: vi.fn(),
      fetch: vi.fn(),
    } as unknown as PluginAPI;

    await activate(api);

    expect(panels).toContainEqual(expect.objectContaining({ id: 'work-items' }));
    expect(settings).toContainEqual(expect.objectContaining({ id: 'rally-settings' }));
    expect(navigation).toContainEqual(expect.objectContaining({ id: 'rally-work-items' }));
    expect(registeredTools.map((tool) => tool.name)).toEqual([
      'rally_auth_status',
      'rally_list_workspaces',
      'rally_list_projects',
      'rally_search_work_items',
      'rally_get_work_item',
      'rally_get_work_item_collections',
      'rally_get_relationships',
      'rally_get_hierarchy',
      'rally_query_planning',
      'rally_get_capacity',
      'rally_sync_status',
      'rally_sync_now',
    ]);
    expect(state.credentials).toEqual(expect.objectContaining({ configured: false, storage: 'safeStorage' }));

    deactivate(api);
  });
});
