import type {
  KaiTask,
  KaiTaskChangeEvent,
  KaiTaskExternalLink,
  KaiTaskInput,
  KaiTaskStatus,
  PluginAPI,
  TaskBoardSyncResult,
  TaskBoardSyncSettings,
  WorkItem,
  WorkItemType,
} from '../shared/types.js';
import { RallyConflictError, type RallyClient } from './rally-client.js';

type ExternalIdentity = Omit<KaiTaskExternalLink, 'pluginName' | 'syncedAt'>;

type TaskBoardSnapshotEntry = {
  source: string;
  externalId: string;
  externalKey: string;
  taskId: string;
  managedByWatch: boolean;
};

type TaskBoardSnapshot = Record<string, TaskBoardSnapshotEntry>;

const TASK_BOARD_SNAPSHOT_KEY = 'taskBoardSnapshot';
const TASK_BOARD_DISMISSED_KEY = 'taskBoardDismissed';
const PUSH_FIELDS = new Set<keyof KaiTask>(['title', 'description', 'status']);

function emptyResult(): TaskBoardSyncResult {
  return { created: 0, updated: 0, unchanged: 0, unarchived: 0, archived: 0, pushed: 0, failed: 0 };
}

function externalKey(source: string, externalId: string): string {
  return `${source}\u0000${externalId}`;
}

function snapshot(api: PluginAPI): TaskBoardSnapshot {
  const value = api.config.getPluginData()[TASK_BOARD_SNAPSHOT_KEY];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as TaskBoardSnapshot
    : {};
}

function dismissed(api: PluginAPI): Set<string> {
  const value = api.config.getPluginData()[TASK_BOARD_DISMISSED_KEY];
  return new Set(Array.isArray(value) ? value.map(String) : []);
}

function saveDismissed(api: PluginAPI, values: Set<string>): void {
  api.config.setPluginData(TASK_BOARD_DISMISSED_KEY, [...values].sort());
}

function decodeHtmlEntity(entity: string): string {
  const normalized = entity.toLowerCase();
  const named: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', hellip: '…', lt: '<', nbsp: ' ', quot: '"',
  };
  if (normalized.startsWith('#x')) {
    const value = Number.parseInt(entity.slice(2), 16);
    return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
      ? String.fromCodePoint(value)
      : `&${entity};`;
  }
  if (normalized.startsWith('#')) {
    const value = Number.parseInt(entity.slice(1), 10);
    return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
      ? String.fromCodePoint(value)
      : `&${entity};`;
  }
  return named[normalized] ?? `&${entity};`;
}

/** Convert Rally's HTML descriptions into readable task-plan text without executing markup. */
export function rallyDescription(value?: string): string {
  if (!value) return '';
  return value
    .replace(/<\s*(?:script|style)\b[^>]*>[\s\S]*?<\s*\/\s*(?:script|style)\s*>/gi, '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '- ')
    .replace(/<\s*\/\s*(?:p|div|li|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&([a-z]+|#\d+|#x[\da-f]+);/gi, (_match, entity: string) => decodeHtmlEntity(entity))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 50_000);
}

function normalizedState(item: WorkItem): string {
  return String(item.scheduleState ?? item.state ?? '').trim().toLowerCase();
}

/** Map Rally's work-item-specific state vocabulary onto Kai's workflow. */
export function rallyStatusToKai(item: WorkItem, current?: KaiTaskStatus): KaiTaskStatus {
  const state = normalizedState(item);
  let mapped: KaiTaskStatus;
  if (item.type === 'Defect') {
    if (state === 'closed') mapped = 'done';
    else if (state === 'fixed') mapped = 'human_review';
    else if (['open', 're-open', 're-test'].includes(state)) mapped = 'in_progress';
    else mapped = 'todo';
  } else if (item.type === 'Task') {
    if (['completed', 'accepted', 'closed', 'done'].includes(state)) mapped = 'done';
    else if (state.includes('progress')) mapped = 'in_progress';
    else mapped = 'todo';
  } else if (item.type === 'HierarchicalRequirement') {
    if (state === 'accepted') mapped = 'done';
    else if (state === 'completed') mapped = 'human_review';
    else if (state === 'in-progress') mapped = 'in_progress';
    else mapped = 'todo';
  } else if (['accepted', 'closed', 'done'].includes(state)) {
    mapped = 'done';
  } else if (['completed', 'fixed'].includes(state)) {
    mapped = 'human_review';
  } else if (state.includes('progress') || state === 'open') {
    mapped = 'in_progress';
  } else {
    mapped = 'todo';
  }

  // These Kai states intentionally collapse to one Rally state. Preserve the
  // richer local state when a pull confirms the same remote state family.
  if (mapped === 'in_progress' && current === 'blocked') return current;
  if (mapped === 'human_review' && current === 'ai_review') return current;
  return mapped;
}

/** Return the Rally fields that can faithfully represent a Kai status. */
export function kaiStatusToRally(type: WorkItemType, status: KaiTaskStatus): Record<string, unknown> {
  if (type === 'HierarchicalRequirement') {
    return {
      ScheduleState: status === 'done'
        ? 'Accepted'
        : status === 'ai_review' || status === 'human_review'
          ? 'Completed'
          : status === 'todo'
            ? 'Defined'
            : 'In-Progress',
    };
  }
  if (type === 'Defect') {
    return {
      State: status === 'done'
        ? 'Closed'
        : status === 'ai_review' || status === 'human_review'
          ? 'Fixed'
          : status === 'todo'
            ? 'Submitted'
            : 'Open',
    };
  }
  if (type === 'Task') {
    return {
      State: status === 'done'
        ? 'Completed'
        : status === 'todo'
          ? 'Defined'
          : 'In-Progress',
    };
  }
  return {};
}

function itemTypeFromExternalId(value: string): WorkItemType | null {
  const type = value.slice(0, value.lastIndexOf(':')) as WorkItemType;
  return [
    'HierarchicalRequirement',
    'Defect',
    'PortfolioItem/Feature',
    'PortfolioItem/SolutionCapability',
    'Task',
    'TestCase',
  ].includes(type) ? type : null;
}

export function externalIdentity(item: WorkItem): ExternalIdentity {
  let host = 'rally';
  try {
    host = new URL(item.ref).host.toLowerCase();
  } catch {
    // Work-item refs normally contain the origin; the stable fallback still
    // keeps identities namespaced to this plugin.
  }
  const resolvedWorkspaceObjectId = item.workspace?.ObjectID
    ?? Number(item.workspace?._ref?.match(/\/(\d+)(?:\.json)?$/)?.[1] ?? 0);
  const workspaceObjectId = resolvedWorkspaceObjectId || 'unknown';
  return {
    source: `rally:${host}:workspace:${workspaceObjectId}`,
    externalId: `${item.type}:${item.objectId}`,
    externalKey: item.formattedId,
    url: item.url,
    revision: item.lastUpdateDate,
  };
}

function taskInput(item: WorkItem, settings: TaskBoardSyncSettings, current?: KaiTask): KaiTaskInput {
  return {
    title: (item.name.trim() || item.formattedId).slice(0, 500),
    description: rallyDescription(item.description ?? item.notes),
    status: rallyStatusToKai(item, current?.status),
    ...(settings.workspaceId ? { workspaceId: settings.workspaceId } : {}),
  };
}

function ownLink(
  api: PluginAPI,
  task?: KaiTask,
  identity?: Pick<ExternalIdentity, 'source' | 'externalId'>,
): KaiTaskExternalLink | undefined {
  return task?.externalLinks?.find((link) => (
    link.pluginName === api.pluginName
    && link.source.startsWith('rally:')
    && (!identity || (link.source === identity.source && link.externalId === identity.externalId))
  ));
}

function sameTask(task: KaiTask, input: KaiTaskInput, link: KaiTaskExternalLink, identity: ExternalIdentity): boolean {
  return task.title === input.title
    && task.description === (input.description ?? '')
    && task.status === (input.status ?? 'todo')
    && (input.workspaceId === undefined || task.workspaceId === input.workspaceId)
    && link.externalKey === identity.externalKey
    && link.url === identity.url
    && link.revision === identity.revision;
}

export function activeKaiWorkspaceId(api: PluginAPI): string | undefined {
  const config = api.config.get();
  const ui = config.ui && typeof config.ui === 'object' ? config.ui as Record<string, unknown> : {};
  const value = typeof ui.activeWorkspaceId === 'string' ? ui.activeWorkspaceId.trim() : '';
  return value && value.length <= 100 ? value : undefined;
}

export class RallyTaskBoardSync {
  private disposeTaskListener: (() => void) | null = null;
  private settings: TaskBoardSyncSettings = { enabled: false, bidirectional: true, archiveMissing: true };
  private queues = new Map<string, Promise<void>>();
  private pushed = 0;
  private failed = 0;

  constructor(
    private readonly api: PluginAPI,
    private readonly getClient: () => RallyClient,
    private readonly recordConflict: (conflict: {
      formattedId: string;
      operation: string;
      expectedLastUpdateDate: string;
      actualLastUpdateDate?: string;
    }) => void,
  ) {}

  configure(settings: TaskBoardSyncSettings): void {
    this.settings = { ...settings };
    const shouldListen = settings.enabled;
    if (shouldListen && !this.disposeTaskListener) {
      this.disposeTaskListener = this.api.tasks.onChanged((event) => this.queueChange(event));
    } else if (!shouldListen && this.disposeTaskListener) {
      this.disposeTaskListener();
      this.disposeTaskListener = null;
    }
  }

  stop(): void {
    this.disposeTaskListener?.();
    this.disposeTaskListener = null;
    this.queues.clear();
  }

  async importItems(
    items: WorkItem[],
    settings = this.settings,
    options: { explicit?: boolean; taskId?: string; replaceSnapshot?: boolean } = {},
  ): Promise<TaskBoardSyncResult> {
    const result = emptyResult();
    result.pushed = this.pushed;
    result.failed = this.failed;
    const tasks = await this.api.tasks.list({ includeArchived: true });
    const taskByIdentity = new Map<string, KaiTask>();
    for (const task of tasks) {
      for (const link of task.externalLinks ?? []) {
        if (link.pluginName === this.api.pluginName && link.source.startsWith('rally:')) {
          taskByIdentity.set(externalKey(link.source, link.externalId), task);
        }
      }
    }
    const ignored = dismissed(this.api);
    const nextSnapshot: TaskBoardSnapshot = {};

    for (const item of items) {
      const identity = externalIdentity(item);
      const key = externalKey(identity.source, identity.externalId);
      if (options.explicit) ignored.delete(key);
      if (!options.explicit && ignored.has(key)) continue;
      const existing = taskByIdentity.get(key)
        ?? (options.taskId ? tasks.find((task) => task.id === options.taskId) : undefined);
      const existingRallyLink = existing ? ownLink(this.api, existing) : undefined;
      if (
        options.taskId
        && existingRallyLink
        && (existingRallyLink.source !== identity.source || existingRallyLink.externalId !== identity.externalId)
      ) {
        throw new Error(`Kai task ${options.taskId} is already linked to Rally item ${existingRallyLink.externalKey ?? existingRallyLink.externalId}.`);
      }
      const input = taskInput(item, settings, existing);
      const link = existing ? ownLink(this.api, existing, identity) : undefined;

      let task = existing;
      if (existing && link && sameTask(existing, input, link, identity)) {
        result.unchanged += 1;
      } else {
        // Kai's state machine intentionally requires blocked work to resume
        // before it can complete or enter review. Bridge that transition when
        // Rally is the authoritative source for the later state.
        if (
          existing?.status === 'blocked'
          && (input.status === 'ai_review' || input.status === 'human_review' || input.status === 'done')
        ) {
          await this.api.tasks.update(
            existing.id,
            { status: 'in_progress' },
            { correlationId: `rally-transition:${item.formattedId}:resume` },
          );
        }
        const upserted = await this.api.tasks.upsertExternal(
          { external: identity, task: input, ...(options.taskId ? { taskId: options.taskId } : {}) },
          { correlationId: `rally-pull:${item.formattedId}:${item.lastUpdateDate ?? 'unversioned'}` },
        );
        task = upserted.task;
        if (upserted.created) result.created += 1;
        else result.updated += 1;
        taskByIdentity.set(key, task);
      }
      if (task?.archivedAt) {
        task = await this.api.tasks.unarchive(task.id, { correlationId: `rally-unarchive:${item.formattedId}` });
        result.unarchived += 1;
        taskByIdentity.set(key, task);
      }
      if (task) {
        nextSnapshot[key] = {
          source: identity.source,
          externalId: identity.externalId,
          externalKey: item.formattedId,
          taskId: task.id,
          managedByWatch: options.replaceSnapshot === true,
        };
      }
    }

    if (options.explicit) saveDismissed(this.api, ignored);
    this.api.config.setPluginData(
      TASK_BOARD_SNAPSHOT_KEY,
      options.replaceSnapshot ? nextSnapshot : { ...snapshot(this.api), ...nextSnapshot },
    );
    return result;
  }

  async mirrorItems(
    items: WorkItem[],
    complete: boolean,
    settings = this.settings,
  ): Promise<TaskBoardSyncResult> {
    const previous = snapshot(this.api);
    const result = await this.importItems(items, settings, { replaceSnapshot: true });
    const current = snapshot(this.api);

    if (!complete) {
      this.api.config.setPluginData(TASK_BOARD_SNAPSHOT_KEY, { ...previous, ...current });
      return result;
    }
    if (!settings.archiveMissing) {
      this.api.config.setPluginData(TASK_BOARD_SNAPSHOT_KEY, { ...previous, ...current });
      return result;
    }

    const tasks = new Map((await this.api.tasks.list({ includeArchived: true })).map((task) => [task.id, task]));
    for (const [key, entry] of Object.entries(previous)) {
      if (current[key]) continue;
      if (entry.managedByWatch !== true) continue;
      const task = tasks.get(entry.taskId);
      if (!task || task.archivedAt) continue;
      await this.api.tasks.archive(task.id, { correlationId: `rally-missing:${entry.externalKey}` });
      result.archived += 1;
    }
    return result;
  }

  private queueChange(event: KaiTaskChangeEvent): Promise<void> {
    const prior = this.queues.get(event.taskId) ?? Promise.resolve();
    const next = prior
      .catch(() => undefined)
      .then(() => this.handleChange(event))
      .catch((error) => {
        this.failed += 1;
        this.api.log.warn(`Could not synchronize Kai task ${event.taskId} to Rally: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (this.queues.get(event.taskId) === next) this.queues.delete(event.taskId);
      });
    this.queues.set(event.taskId, next);
    return next;
  }

  private async handleChange(event: KaiTaskChangeEvent): Promise<void> {
    if (event.origin.type === 'plugin' && event.origin.pluginName === this.api.pluginName) return;
    const eventTask = event.task ?? event.previous;
    const eventLink = ownLink(this.api, eventTask);
    if (!eventLink) return;
    const key = externalKey(eventLink.source, eventLink.externalId);

    if (event.type === 'archived' || event.type === 'deleted') {
      const ignored = dismissed(this.api);
      ignored.add(key);
      saveDismissed(this.api, ignored);
      return;
    }
    if (event.type === 'unarchived') {
      const ignored = dismissed(this.api);
      ignored.delete(key);
      saveDismissed(this.api, ignored);
    }
    if (!this.settings.enabled || !this.settings.bidirectional) return;
    if (!event.changedFields.some((field) => PUSH_FIELDS.has(field))) return;

    const task = await this.api.tasks.get(event.taskId);
    const link = ownLink(this.api, task ?? undefined);
    if (!task || !link || task.archivedAt || !link.externalKey) return;
    const type = itemTypeFromExternalId(link.externalId);
    if (!type) return;

    const fields: Record<string, unknown> = {};
    if (event.changedFields.includes('title')) fields.Name = task.title;
    if (event.changedFields.includes('description')) fields.Description = task.description;
    if (event.changedFields.includes('status')) Object.assign(fields, kaiStatusToRally(type, task.status));
    if (!Object.keys(fields).length) return;

    try {
      const updated = await this.getClient().updateWorkItem(
        link.externalKey,
        fields,
        false,
        link.revision,
      );
      const identity = externalIdentity(updated);
      await this.api.tasks.upsertExternal(
        {
          taskId: task.id,
          external: { ...identity, source: link.source, externalId: link.externalId },
          task: {
            title: task.title,
            description: task.description,
            status: task.status,
            ...(task.workspaceId ? { workspaceId: task.workspaceId } : {}),
            ...(typeof task.priority === 'number' ? { priority: task.priority } : {}),
          },
        },
        { correlationId: `rally-push:${task.id}:${updated.lastUpdateDate ?? Date.now()}` },
      );
      this.pushed += 1;
    } catch (error) {
      if (error instanceof RallyConflictError) {
        this.recordConflict(error.conflict);
        return;
      }
      throw error;
    }
  }
}
