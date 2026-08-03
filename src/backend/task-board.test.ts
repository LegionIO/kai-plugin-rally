import { describe, expect, it, vi } from 'vitest';
import type {
  KaiTask,
  KaiTaskChangeEvent,
  PluginAPI,
  TaskBoardSyncSettings,
  WorkItem,
} from '../shared/types.js';
import type { RallyClient } from './rally-client.js';
import {
  externalIdentity,
  kaiStatusToRally,
  RallyTaskBoardSync,
  rallyDescription,
  rallyStatusToKai,
} from './task-board.js';

const settings: TaskBoardSyncSettings = {
  enabled: true,
  bidirectional: true,
  archiveMissing: true,
  workspaceId: 'kai-workspace',
};

function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    type: 'HierarchicalRequirement',
    typeLabel: 'User Story',
    objectId: 42,
    formattedId: 'US42',
    name: 'Synced story',
    description: '<p>Hello <strong>Rally</strong></p><ul><li>First</li></ul>',
    scheduleState: 'In-Progress',
    lastUpdateDate: '2026-08-03T12:00:00.000Z',
    workspace: {
      ObjectID: 12345,
      _ref: 'https://rally1.rallydev.com/slm/webservice/v2.0/workspace/12345',
    },
    ref: 'https://rally1.rallydev.com/slm/webservice/v2.0/hierarchicalrequirement/42',
    url: 'https://rally1.rallydev.com/#/?detail=/hierarchicalrequirement/42',
    ...overrides,
  };
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== 'object') cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1)!] = value;
}

function harness(initialTasks: KaiTask[] = []) {
  const config: Record<string, unknown> = {};
  const tasks = [...initialTasks];
  let changeHandler: ((event: KaiTaskChangeEvent) => void | Promise<void>) | undefined;
  const upsertExternal = vi.fn(async (input: Parameters<PluginAPI['tasks']['upsertExternal']>[0]) => {
    const existing = tasks.find((task) => task.id === input.taskId || task.externalLinks?.some((link) => (
      link.pluginName === 'rally'
      && link.source === input.external.source
      && link.externalId === input.external.externalId
    )));
    const link = {
      ...input.external,
      pluginName: 'rally',
      syncedAt: '2026-08-03T12:01:00.000Z',
    };
    if (existing) {
      Object.assign(existing, input.task, {
        externalLinks: [
          ...(existing.externalLinks ?? []).filter((value) => value.pluginName !== 'rally'),
          link,
        ],
      });
      return { task: existing, created: false };
    }
    const task: KaiTask = {
      id: `task-${tasks.length + 1}`,
      title: input.task.title,
      description: input.task.description ?? '',
      status: input.task.status ?? 'todo',
      workspaceId: input.task.workspaceId,
      createdAt: '2026-08-03T12:01:00.000Z',
      updatedAt: '2026-08-03T12:01:00.000Z',
      externalLinks: [link],
    };
    tasks.push(task);
    return { task, created: true };
  });
  const api = {
    pluginName: 'rally',
    config: {
      get: () => ({ ui: { activeWorkspaceId: 'kai-workspace' } }),
      getPluginData: () => config,
      setPluginData: (path: string, value: unknown) => setPath(config, path, value),
    },
    tasks: {
      list: vi.fn(async () => tasks),
      get: vi.fn(async (id: string) => tasks.find((task) => task.id === id) ?? null),
      upsertExternal,
      archive: vi.fn(async (id: string) => {
        const task = tasks.find((value) => value.id === id)!;
        task.archivedAt = '2026-08-03T12:02:00.000Z';
        return task;
      }),
      unarchive: vi.fn(async (id: string) => {
        const task = tasks.find((value) => value.id === id)!;
        delete task.archivedAt;
        return task;
      }),
      onChanged: vi.fn((handler: typeof changeHandler) => {
        changeHandler = handler;
        return () => { changeHandler = undefined; };
      }),
    },
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  } as unknown as PluginAPI;
  return { api, config, tasks, upsertExternal, getChangeHandler: () => changeHandler };
}

describe('Rally task-board mapping', () => {
  it('maps HTML and the Rally/Kai state families without losing richer local review states', () => {
    expect(rallyDescription('<p>A &amp; B</p><li>One</li>')).toBe('A & B\n- One');
    expect(rallyStatusToKai(workItem({ scheduleState: 'Completed' }), 'ai_review')).toBe('ai_review');
    expect(rallyStatusToKai(workItem({ scheduleState: 'In-Progress' }), 'blocked')).toBe('blocked');
    expect(rallyStatusToKai(workItem({ scheduleState: 'Accepted' }))).toBe('done');
    expect(kaiStatusToRally('HierarchicalRequirement', 'human_review')).toEqual({ ScheduleState: 'Completed' });
    expect(kaiStatusToRally('Defect', 'done')).toEqual({ State: 'Closed' });
    expect(kaiStatusToRally('PortfolioItem/Feature', 'done')).toEqual({});
  });

  it('imports by stable identity and does not churn unchanged cards', async () => {
    const { api, config, tasks, upsertExternal } = harness();
    const board = new RallyTaskBoardSync(api, () => ({} as RallyClient), vi.fn());

    const first = await board.importItems([workItem()], settings, { explicit: true });
    const second = await board.importItems([workItem()], settings, { explicit: true });

    expect(first).toEqual(expect.objectContaining({ created: 1, updated: 0 }));
    expect(second).toEqual(expect.objectContaining({ created: 0, unchanged: 1 }));
    expect(upsertExternal).toHaveBeenCalledOnce();
    expect(tasks[0]).toEqual(expect.objectContaining({
      title: 'Synced story',
      description: 'Hello Rally\n- First',
      status: 'in_progress',
      workspaceId: 'kai-workspace',
    }));
    expect(config.taskBoardSnapshot).toBeTruthy();
    expect(externalIdentity(workItem())).toEqual(expect.objectContaining({
      source: 'rally:rally1.rallydev.com:workspace:12345',
      externalId: 'HierarchicalRequirement:42',
      externalKey: 'US42',
    }));
  });

  it('pushes local title and status changes with the linked Rally revision', async () => {
    const identity = externalIdentity(workItem());
    const task: KaiTask = {
      id: 'task-1',
      title: 'Renamed locally',
      description: 'Hello Rally\n- First',
      status: 'human_review',
      createdAt: '2026-08-03T12:00:00.000Z',
      updatedAt: '2026-08-03T12:05:00.000Z',
      externalLinks: [{ ...identity, pluginName: 'rally', syncedAt: '2026-08-03T12:00:00.000Z' }],
    };
    const { api, upsertExternal, getChangeHandler } = harness([task]);
    const updateWorkItem = vi.fn(async () => workItem({
      name: 'Renamed locally',
      scheduleState: 'Completed',
      lastUpdateDate: '2026-08-03T12:06:00.000Z',
    }));
    const board = new RallyTaskBoardSync(
      api,
      () => ({ updateWorkItem } as unknown as RallyClient),
      vi.fn(),
    );
    board.configure(settings);

    await getChangeHandler()!({
      type: 'updated',
      taskId: task.id,
      task,
      previous: { ...task, title: 'Old', status: 'in_progress' },
      changedFields: ['title', 'status'],
      origin: { type: 'app' },
      timestamp: '2026-08-03T12:05:00.000Z',
    });

    expect(updateWorkItem).toHaveBeenCalledWith(
      'US42',
      { Name: 'Renamed locally', ScheduleState: 'Completed' },
      false,
      '2026-08-03T12:00:00.000Z',
    );
    expect(upsertExternal).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: task.id }),
      expect.objectContaining({ correlationId: expect.stringContaining('rally-push:task-1:') }),
    );
  });

  it('keeps a manually archived Rally card dismissed on later watch polls', async () => {
    const item = workItem();
    const identity = externalIdentity(item);
    const task: KaiTask = {
      id: 'task-1',
      title: item.name,
      description: rallyDescription(item.description),
      status: 'in_progress',
      createdAt: '2026-08-03T12:00:00.000Z',
      updatedAt: '2026-08-03T12:00:00.000Z',
      archivedAt: '2026-08-03T12:10:00.000Z',
      externalLinks: [{ ...identity, pluginName: 'rally', syncedAt: '2026-08-03T12:00:00.000Z' }],
    };
    const { api, config, upsertExternal, getChangeHandler } = harness([task]);
    const key = `${identity.source}\u0000${identity.externalId}`;
    config.taskBoardSnapshot = {
      [key]: {
        source: identity.source,
        externalId: identity.externalId,
        externalKey: item.formattedId,
        taskId: task.id,
        managedByWatch: true,
      },
    };
    const board = new RallyTaskBoardSync(api, () => ({} as RallyClient), vi.fn());
    board.configure(settings);

    await getChangeHandler()!({
      type: 'archived',
      taskId: task.id,
      task,
      changedFields: ['archivedAt'],
      origin: { type: 'app' },
      timestamp: '2026-08-03T12:10:00.000Z',
    });
    await board.mirrorItems([item], true, settings);

    expect(upsertExternal).not.toHaveBeenCalled();
    expect(config.taskBoardDismissed).toContain(key);
    expect(config.taskBoardSnapshot).toEqual({});
  });
});
