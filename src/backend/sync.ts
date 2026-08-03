import { randomUUID } from 'node:crypto';
import { DEFAULT_SEARCH_ORDER, DEFAULT_SYNC_SETTINGS } from '../shared/constants.js';
import type {
  PluginAPI,
  SyncChange,
  SyncConflict,
  SyncSettings,
  SyncStatus,
  SyncWatch,
  TaskBoardSyncResult,
  TaskBoardSyncSettings,
  WorkItem,
} from '../shared/types.js';
import type { RallyClient } from './rally-client.js';
import { activeKaiWorkspaceId, RallyTaskBoardSync } from './task-board.js';

type SnapshotItem = {
  formattedId: string;
  name: string;
  lastUpdateDate?: string;
  url: string;
};

type WatchSnapshot = {
  initializedAt: string;
  complete: boolean;
  items: Record<string, SnapshotItem>;
};

type SnapshotStore = Record<string, WatchSnapshot>;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))]
    : [];
}

export function syncSettings(api: PluginAPI): SyncSettings {
  const configured = api.config.getPluginData().sync;
  const raw = configured && typeof configured === 'object'
    ? configured as Partial<SyncSettings>
    : {};
  const watches = Array.isArray(raw.watches)
    ? raw.watches.filter((value): value is SyncWatch => Boolean(value && typeof value === 'object'))
      .map((watch) => ({
        id: String(watch.id || randomUUID()),
        name: String(watch.name || 'Rally watch'),
        enabled: watch.enabled !== false,
        query: String(watch.query || '').trim(),
        workspace: watch.workspace ? String(watch.workspace) : undefined,
        projects: cleanStringArray(watch.projects),
        types: cleanStringArray(watch.types),
        order: watch.order ? String(watch.order) : DEFAULT_SEARCH_ORDER,
        projectScopeUp: watch.projectScopeUp === true,
        projectScopeDown: watch.projectScopeDown === true,
      })).filter((watch) => Boolean(watch.query))
    : [];
  const configuredTaskBoard = raw.taskBoard && typeof raw.taskBoard === 'object'
    ? raw.taskBoard as Partial<TaskBoardSyncSettings>
    : {};
  return {
    enabled: raw.enabled === true,
    intervalSeconds: Math.max(30, Math.min(86_400, Number(raw.intervalSeconds) || DEFAULT_SYNC_SETTINGS.intervalSeconds)),
    notifications: raw.notifications !== false,
    notifyOnNew: raw.notifyOnNew !== false,
    notifyOnUpdated: raw.notifyOnUpdated !== false,
    maxItemsPerWatch: Math.max(1, Math.min(1000, Number(raw.maxItemsPerWatch) || DEFAULT_SYNC_SETTINGS.maxItemsPerWatch)),
    watches,
    taskBoard: {
      enabled: configuredTaskBoard.enabled === true,
      bidirectional: configuredTaskBoard.bidirectional !== false,
      archiveMissing: configuredTaskBoard.archiveMissing !== false,
      workspaceId: typeof configuredTaskBoard.workspaceId === 'string' && configuredTaskBoard.workspaceId.trim()
        ? configuredTaskBoard.workspaceId.trim()
        : undefined,
    },
  };
}

function snapshots(api: PluginAPI): SnapshotStore {
  const value = api.config.getPluginData().syncSnapshots;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as SnapshotStore
    : {};
}

function initialStatus(): SyncStatus {
  return { running: false, changes: [], conflicts: [] };
}

export class RallySyncManager {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private settingsFingerprint = '';
  private status: SyncStatus = initialStatus();
  private readonly taskBoard: RallyTaskBoardSync;

  constructor(
    private readonly api: PluginAPI,
    private readonly getClient: () => RallyClient,
  ) {
    this.taskBoard = new RallyTaskBoardSync(api, getClient, (conflict) => this.recordConflict(conflict));
  }

  getStatus(): SyncStatus {
    return { ...this.status, changes: [...this.status.changes], conflicts: [...this.status.conflicts] };
  }

  getSettings(): SyncSettings {
    return syncSettings(this.api);
  }

  start(): void {
    this.reconfigure(true);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.taskBoard.stop();
    this.status = { ...this.status, running: false, nextRunAt: undefined };
    this.publish();
  }

  reconfigure(force = false): void {
    const settings = this.getSettings();
    this.taskBoard.configure(settings.taskBoard);
    const fingerprint = JSON.stringify(settings);
    if (!force && fingerprint === this.settingsFingerprint) return;
    this.settingsFingerprint = fingerprint;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!settings.enabled) {
      this.status = { ...this.status, running: false, nextRunAt: undefined };
      this.publish();
      return;
    }
    const intervalMs = settings.intervalSeconds * 1000;
    this.status = { ...this.status, nextRunAt: new Date(Date.now() + intervalMs).toISOString() };
    this.publish();
    this.timer = setInterval(() => {
      void this.runNow('timer').catch((error) => {
        this.api.log.warn(`Rally background sync failed: ${message(error)}`);
      });
    }, intervalMs);
  }

  async runNow(source: 'manual' | 'timer' | 'activation' = 'manual'): Promise<SyncStatus> {
    if (this.running) return this.getStatus();
    this.running = true;
    const settings = this.getSettings();
    const startedAt = new Date().toISOString();
    this.status = { ...this.status, running: true, lastStartedAt: startedAt, error: undefined };
    this.publish();
    const store = snapshots(this.api);
    const nextStore: SnapshotStore = { ...store };
    const changes: SyncChange[] = [];
    const boardItems = new Map<string, WorkItem>();
    let boardSnapshotComplete = true;
    try {
      const client = this.getClient();
      const enabledWatches = settings.watches.filter((value) => value.enabled);
      for (const watch of enabledWatches) {
        const items: WorkItem[] = [];
        let page = 1;
        let complete = true;
        while (items.length < settings.maxItemsPerWatch) {
          const result = await client.searchWorkItemsPage(watch.query, {
            workspace: watch.workspace,
            projects: watch.projects,
            types: watch.types,
            order: watch.order,
            projectScopeUp: watch.projectScopeUp,
            projectScopeDown: watch.projectScopeDown,
            page,
            pageSize: Math.min(200, settings.maxItemsPerWatch - items.length),
          });
          items.push(...result.items);
          if (!result.hasMore) break;
          if (items.length >= settings.maxItemsPerWatch) {
            complete = false;
            boardSnapshotComplete = false;
            break;
          }
          page += 1;
        }
        for (const item of items) boardItems.set(item.ref || `${item.type}:${item.objectId}`, item);
        const current = Object.fromEntries(items.map((item) => [item.ref, {
          formattedId: item.formattedId,
          name: item.name,
          lastUpdateDate: item.lastUpdateDate,
          url: item.url,
        }]));
        const previous = store[watch.id];
        if (previous) {
          for (const [ref, item] of Object.entries(current)) {
            const before = previous.items[ref];
            if (!before) {
              changes.push({
                kind: 'new', watchId: watch.id, watchName: watch.name,
                formattedId: item.formattedId, name: item.name,
                lastUpdateDate: item.lastUpdateDate, url: item.url,
              });
            } else if (before.lastUpdateDate !== item.lastUpdateDate) {
              changes.push({
                kind: 'updated', watchId: watch.id, watchName: watch.name,
                formattedId: item.formattedId, name: item.name,
                previousLastUpdateDate: before.lastUpdateDate,
                lastUpdateDate: item.lastUpdateDate, url: item.url,
              });
            }
          }
          if (previous.complete && complete) {
            for (const [ref, item] of Object.entries(previous.items)) {
              if (!current[ref]) {
                changes.push({
                  kind: 'removed', watchId: watch.id, watchName: watch.name,
                  formattedId: item.formattedId, name: item.name,
                  previousLastUpdateDate: item.lastUpdateDate, url: item.url,
                });
              }
            }
          }
        }
        nextStore[watch.id] = { initializedAt: previous?.initializedAt ?? startedAt, complete, items: current };
      }
      const validIds = new Set(settings.watches.map((watch) => watch.id));
      for (const id of Object.keys(nextStore)) if (!validIds.has(id)) delete nextStore[id];
      this.api.config.setPluginData('syncSnapshots', nextStore);
      for (const change of changes) this.api.state.emitEvent('work-item-changed', change);
      const taskBoard = settings.taskBoard.enabled && enabledWatches.length > 0
        ? await this.taskBoard.mirrorItems([...boardItems.values()], boardSnapshotComplete, settings.taskBoard)
        : this.status.taskBoard;
      const completedAt = new Date().toISOString();
      this.status = {
        ...this.status,
        running: false,
        lastCompletedAt: completedAt,
        nextRunAt: settings.enabled
          ? new Date(Date.now() + settings.intervalSeconds * 1000).toISOString()
          : undefined,
        changes: changes.slice(0, 100),
        taskBoard,
      };
      this.api.state.emitEvent('sync-completed', { source, completedAt, changes, taskBoard });
      this.notify(settings, changes);
      return this.getStatus();
    } catch (error) {
      this.status = { ...this.status, running: false, error: message(error) };
      throw error;
    } finally {
      this.running = false;
      this.publish();
    }
  }

  saveSettings(patch: Partial<Omit<SyncSettings, 'taskBoard'>> & { taskBoard?: Partial<TaskBoardSyncSettings> }): SyncSettings {
    const current = this.getSettings();
    const requestedInterval = Number(patch.intervalSeconds ?? current.intervalSeconds);
    const requestedMaxItems = Number(patch.maxItemsPerWatch ?? current.maxItemsPerWatch);
    const taskBoard = { ...current.taskBoard, ...patch.taskBoard };
    if (taskBoard.enabled && !taskBoard.workspaceId) {
      taskBoard.workspaceId = activeKaiWorkspaceId(this.api);
    }
    const next: SyncSettings = {
      ...current,
      ...patch,
      intervalSeconds: Number.isFinite(requestedInterval)
        ? Math.max(30, Math.min(86_400, requestedInterval))
        : current.intervalSeconds,
      maxItemsPerWatch: Number.isFinite(requestedMaxItems)
        ? Math.max(1, Math.min(1000, requestedMaxItems))
        : current.maxItemsPerWatch,
      watches: patch.watches ?? current.watches,
      taskBoard,
    };
    this.api.config.setPluginData('sync', next);
    this.reconfigure(true);
    return next;
  }

  async importToTaskBoard(formattedIds: string[], taskId?: string): Promise<TaskBoardSyncResult> {
    const ids = [...new Set(formattedIds.map((value) => value.trim().toUpperCase()).filter(Boolean))];
    if (!ids.length) throw new Error('At least one Rally FormattedID is required.');
    if (taskId && ids.length !== 1) throw new Error('A Kai task can only be linked to one Rally work item at a time.');
    const settings = this.getSettings().taskBoard;
    const effectiveSettings = {
      ...settings,
      workspaceId: settings.workspaceId ?? activeKaiWorkspaceId(this.api),
    };
    const items = await Promise.all(ids.map((id) => this.getClient().getWorkItem(id)));
    return this.taskBoard.importItems(items, effectiveSettings, { explicit: true, taskId });
  }

  upsertWatch(input: Partial<SyncWatch> & { query: string; name?: string }): SyncWatch {
    const settings = this.getSettings();
    const id = String(input.id || randomUUID());
    const watch: SyncWatch = {
      id,
      name: String(input.name || 'Rally watch').trim(),
      enabled: input.enabled !== false,
      query: input.query.trim(),
      workspace: input.workspace?.trim() || undefined,
      projects: cleanStringArray(input.projects),
      types: cleanStringArray(input.types),
      order: input.order?.trim() || DEFAULT_SEARCH_ORDER,
      projectScopeUp: input.projectScopeUp === true,
      projectScopeDown: input.projectScopeDown === true,
    };
    if (!watch.query) throw new Error('A sync watch query is required.');
    const index = settings.watches.findIndex((value) => value.id === id);
    const watches = [...settings.watches];
    if (index >= 0) watches[index] = watch;
    else watches.push(watch);
    this.saveSettings({ watches });
    return watch;
  }

  removeWatch(id: string): { removed: boolean } {
    const settings = this.getSettings();
    const watches = settings.watches.filter((watch) => watch.id !== id);
    const removed = watches.length !== settings.watches.length;
    if (removed) this.saveSettings({ watches });
    return { removed };
  }

  recordConflict(conflict: Omit<SyncConflict, 'detectedAt'>): void {
    const next = { ...conflict, detectedAt: new Date().toISOString() };
    this.status = {
      ...this.status,
      conflicts: [next, ...this.status.conflicts].slice(0, 100),
    };
    this.api.state.emitEvent('sync-conflict', next);
    this.api.notifications.show({
      id: `rally-conflict-${conflict.formattedId}-${Date.now()}`,
      title: `Rally conflict: ${conflict.formattedId}`,
      body: 'The Rally item changed remotely. Refresh before retrying the update.',
      level: 'warning',
      autoDismissMs: 8000,
    });
    this.publish();
  }

  private notify(settings: SyncSettings, changes: SyncChange[]): void {
    if (!settings.notifications || !changes.length) return;
    const visible = changes.filter((change) => (
      change.kind === 'new' ? settings.notifyOnNew : change.kind === 'updated' ? settings.notifyOnUpdated : false
    ));
    if (!visible.length) return;
    const sample = visible.slice(0, 3).map((change) => `${change.formattedId}: ${change.name ?? change.kind}`).join('\n');
    this.api.notifications.show({
      id: `rally-sync-${Date.now()}`,
      title: `${visible.length} Rally change${visible.length === 1 ? '' : 's'}`,
      body: `${sample}${visible.length > 3 ? `\n…and ${visible.length - 3} more` : ''}`,
      level: 'info',
      autoDismissMs: 7000,
    });
  }

  private publish(): void {
    this.api.state.set('sync', this.getStatus());
  }
}
