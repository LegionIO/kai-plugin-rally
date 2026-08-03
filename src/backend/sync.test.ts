import { describe, expect, it, vi } from 'vitest';
import type { PluginAPI, WorkItem } from '../shared/types.js';
import { RallySyncManager } from './sync.js';

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== 'object') cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1)!] = value;
}

function item(lastUpdateDate: string): WorkItem {
  return {
    type: 'HierarchicalRequirement',
    typeLabel: 'User Story',
    objectId: 1,
    formattedId: 'US1',
    name: 'Watched story',
    lastUpdateDate,
    ref: 'https://rally1.rallydev.com/slm/webservice/v2.0/hierarchicalrequirement/1',
    url: 'https://rally1.rallydev.com/#/?detail=/hierarchicalrequirement/1',
  };
}

describe('RallySyncManager', () => {
  it('uses the first poll as a baseline and emits later remote changes', async () => {
    const config: Record<string, unknown> = {
      sync: {
        enabled: true,
        intervalSeconds: 300,
        notifications: false,
        watches: [{ id: 'mine', name: 'My work', enabled: true, query: '(Owner = me)' }],
      },
    };
    let state: Record<string, unknown> = {};
    const emitEvent = vi.fn();
    const searchWorkItemsPage = vi.fn()
      .mockResolvedValueOnce({ items: [item('2026-08-03T10:00:00.000Z')], page: 1, pageSize: 200, total: 1, hasMore: false })
      .mockResolvedValueOnce({ items: [item('2026-08-03T11:00:00.000Z')], page: 1, pageSize: 200, total: 1, hasMore: false });
    const api = {
      config: {
        getPluginData: () => config,
        setPluginData: (path: string, value: unknown) => setPath(config, path, value),
      },
      state: {
        set: (path: string, value: unknown) => setPath(state, path, value),
        emitEvent,
      },
      notifications: { show: vi.fn() },
      log: { warn: vi.fn() },
    } as unknown as PluginAPI;
    const manager = new RallySyncManager(api, () => ({ searchWorkItemsPage } as never));

    const baseline = await manager.runNow('manual');
    const changed = await manager.runNow('manual');

    expect(baseline.changes).toEqual([]);
    expect(changed.changes).toEqual([expect.objectContaining({ kind: 'updated', formattedId: 'US1' })]);
    expect(emitEvent).toHaveBeenCalledWith('work-item-changed', expect.objectContaining({ formattedId: 'US1' }));
    expect((state.sync as { running: boolean }).running).toBe(false);
  });
});
