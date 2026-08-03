import { DEFECT_STATES, SCHEDULE_STATES } from '../shared/constants.js';
import type { PluginAPI, ToolPermissions } from '../shared/types.js';
import { RallyConflictError, type RallyClient } from './rally-client.js';
import type { RallySyncManager } from './sync.js';

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: unknown) => Promise<unknown>;
};

type ToolDependencies = {
  api: PluginAPI;
  getClient: () => RallyClient;
  authStatus: () => Record<string, unknown>;
  sync: RallySyncManager;
};

export const ALL_TOOL_NAMES = [
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
  'rally_create_work_item',
  'rally_update_work_item',
  'rally_add_discussion',
  'rally_update_discussion',
  'rally_manage_tags',
  'rally_attach_files',
  'rally_update_state',
  'rally_move_work_item',
  'rally_manage_dependencies',
  'rally_manage_planning_item',
  'rally_manage_capacity',
  'rally_download_attachment',
  'rally_import_to_task_board',
  'rally_manage_sync',
  'rally_wsapi_request',
  'rally_delete_object',
  'rally_delete_attachment',
  'rally_delete_discussion',
] as const;

function objectInput(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function confirmed(data: Record<string, unknown>, operation: string): void {
  if (data.confirmed !== true) {
    throw new Error(`${operation} requires explicit user confirmation. Re-run with confirmed=true only after the user confirms the exact target and fields.`);
  }
}

function safeTool(
  execute: (input: Record<string, unknown>) => Promise<unknown>,
  deps?: ToolDependencies,
): Tool['execute'] {
  return async (input) => {
    try {
      return await execute(objectInput(input));
    } catch (error) {
      if (error instanceof RallyConflictError) {
        deps?.sync.recordConflict(error.conflict);
        return { error: error.message, conflict: error.conflict };
      }
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
}

function readTools(deps: ToolDependencies): Tool[] {
  return [
    {
      name: 'rally_auth_status',
      description: 'Check whether the Rally plugin has encrypted OAuth client credentials and a usable access token. This does not open a login window.',
      inputSchema: { type: 'object', properties: {} },
      execute: safeTool(async () => deps.authStatus()),
    },
    {
      name: 'rally_list_workspaces',
      description: 'List Rally workspaces available to the signed-in user.',
      inputSchema: { type: 'object', properties: {} },
      execute: safeTool(async () => {
        const workspaces = await deps.getClient().listWorkspaces();
        return { count: workspaces.length, workspaces };
      }),
    },
    {
      name: 'rally_list_projects',
      description: 'List Rally projects in a workspace. The workspace may be a name, ObjectID, or Rally ref; the configured workspace is used when omitted.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: { type: 'string', description: 'Workspace name, ObjectID, or ref' },
        },
      },
      execute: safeTool(async (data) => {
        const projects = await deps.getClient().listProjects(data.workspace as string | undefined);
        return { count: projects.length, projects };
      }),
    },
    {
      name: 'rally_search_work_items',
      description: 'Search Rally work items across one or more projects with global pagination, ordering, de-duplication, and project scope-up/scope-down controls.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Rally WSAPI query expression' },
          workspace: { type: 'string', description: 'Optional workspace name, ID, or ref' },
          project: { type: 'string', description: 'Optional project name, ID, or ref' },
          projects: { type: 'array', items: { type: 'string' }, description: 'Optional project names, IDs, or refs for a multi-project search' },
          types: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional work item types to search',
          },
          page: { type: 'number', minimum: 1, default: 1 },
          pageSize: { type: 'number', minimum: 1, maximum: 200, default: 50 },
          order: { type: 'string', default: 'LastUpdateDate DESC', description: 'Rally order expression, for example Rank ASC or LastUpdateDate DESC' },
          projectScopeUp: { type: 'boolean', default: false },
          projectScopeDown: { type: 'boolean', default: false },
        },
        required: ['query'],
      },
      execute: safeTool(async (data) => {
        const query = String(data.query ?? '').trim();
        if (!query) throw new Error('query is required.');
        return deps.getClient().searchWorkItemsPage(query, {
          workspace: data.workspace as string | undefined,
          project: data.project as string | undefined,
          projects: stringArray(data.projects),
          types: stringArray(data.types),
          page: typeof data.page === 'number' ? data.page : undefined,
          pageSize: typeof data.pageSize === 'number' ? data.pageSize : undefined,
          order: data.order as string | undefined,
          projectScopeUp: data.projectScopeUp === true,
          projectScopeDown: data.projectScopeDown === true,
        });
      }),
    },
    {
      name: 'rally_get_work_item',
      description: 'Get one Rally work item by FormattedID, such as US12345, DE12345, F123, C123, TA12345, or TC12345.',
      inputSchema: {
        type: 'object',
        properties: {
          formattedId: { type: 'string', description: 'Rally FormattedID' },
        },
        required: ['formattedId'],
      },
      execute: safeTool(async (data) => deps.getClient().getWorkItem(String(data.formattedId ?? ''))),
    },
    {
      name: 'rally_get_work_item_collections',
      description: 'Read paged discussions, attachments, tags, and revision history for a Rally work item.',
      inputSchema: {
        type: 'object',
        properties: {
          formattedId: { type: 'string' },
          page: { type: 'number', minimum: 1, default: 1 },
          pageSize: { type: 'number', minimum: 1, maximum: 200, default: 50 },
          order: { type: 'string' },
        },
        required: ['formattedId'],
      },
      execute: safeTool(async (data) => deps.getClient().getWorkItemCollections(
        String(data.formattedId ?? ''),
        {
          page: data.page as number | undefined,
          pageSize: data.pageSize as number | undefined,
          order: data.order as string | undefined,
        },
      )),
    },
    {
      name: 'rally_get_relationships',
      description: 'Read parent, portfolio, iteration/release, child-story, task, defect, predecessor, and successor relationships for a Rally work item.',
      inputSchema: {
        type: 'object',
        properties: {
          formattedId: { type: 'string' },
          page: { type: 'number', minimum: 1, default: 1 },
          pageSize: { type: 'number', minimum: 1, maximum: 200, default: 50 },
        },
        required: ['formattedId'],
      },
      execute: safeTool(async (data) => deps.getClient().getRelationships(
        String(data.formattedId ?? ''),
        { page: data.page as number | undefined, pageSize: data.pageSize as number | undefined },
      )),
    },
    {
      name: 'rally_get_hierarchy',
      description: 'Traverse a Rally story/portfolio hierarchy upward and downward with bounded depth and node limits.',
      inputSchema: {
        type: 'object',
        properties: {
          formattedId: { type: 'string' },
          depth: { type: 'number', minimum: 1, maximum: 8, default: 3 },
          maxNodes: { type: 'number', minimum: 1, maximum: 500, default: 100 },
        },
        required: ['formattedId'],
      },
      execute: safeTool(async (data) => deps.getClient().getHierarchy(
        String(data.formattedId ?? ''),
        { depth: data.depth as number | undefined, maxNodes: data.maxNodes as number | undefined },
      )),
    },
    {
      name: 'rally_query_planning',
      description: 'Query Rally iterations, releases, or milestones with paging, ordering, multi-project scope, and scope-up/scope-down controls.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['iteration', 'release', 'milestone'] },
          query: { type: 'string', default: '(ObjectID > 0)' },
          workspace: { type: 'string' },
          project: { type: 'string' },
          projects: { type: 'array', items: { type: 'string' } },
          page: { type: 'number', minimum: 1, default: 1 },
          pageSize: { type: 'number', minimum: 1, maximum: 200, default: 50 },
          order: { type: 'string' },
          projectScopeUp: { type: 'boolean', default: false },
          projectScopeDown: { type: 'boolean', default: false },
        },
        required: ['type'],
      },
      execute: safeTool(async (data) => deps.getClient().queryPlanningItems(
        String(data.type ?? '') as 'iteration' | 'release' | 'milestone',
        String(data.query ?? '(ObjectID > 0)'),
        {
          workspace: data.workspace as string | undefined,
          project: data.project as string | undefined,
          projects: stringArray(data.projects),
          page: data.page as number | undefined,
          pageSize: data.pageSize as number | undefined,
          order: data.order as string | undefined,
          projectScopeUp: data.projectScopeUp === true,
          projectScopeDown: data.projectScopeDown === true,
        },
      )),
    },
    {
      name: 'rally_get_capacity',
      description: 'Read Rally user iteration capacity, optionally filtered by iteration, project, and user.',
      inputSchema: {
        type: 'object',
        properties: {
          iteration: { type: 'string', description: 'Iteration name, ObjectID, or ref' },
          project: { type: 'string' },
          user: { type: 'string', description: 'Username, ObjectID, or ref' },
          page: { type: 'number', minimum: 1, default: 1 },
          pageSize: { type: 'number', minimum: 1, maximum: 200, default: 50 },
          order: { type: 'string' },
        },
      },
      execute: safeTool(async (data) => deps.getClient().queryCapacity({
        iteration: data.iteration as string | undefined,
        project: data.project as string | undefined,
        user: data.user as string | undefined,
        page: data.page as number | undefined,
        pageSize: data.pageSize as number | undefined,
        order: data.order as string | undefined,
      })),
    },
    {
      name: 'rally_sync_status',
      description: 'Read Rally background polling settings, watch definitions, recent changes, and unresolved optimistic-update conflicts.',
      inputSchema: { type: 'object', properties: {} },
      execute: safeTool(async () => ({ settings: deps.sync.getSettings(), status: deps.sync.getStatus() })),
    },
    {
      name: 'rally_sync_now',
      description: 'Run all enabled Rally watch queries now and publish change events/notifications.',
      inputSchema: { type: 'object', properties: {} },
      execute: safeTool(async () => deps.sync.runNow('manual')),
    },
  ];
}

function writeTools(deps: ToolDependencies): Tool[] {
  return [
    {
      name: 'rally_create_work_item',
      description: 'Create a Rally work item after the user confirms the exact type and fields. Markdown descriptions are converted to HTML. Defects require severity, environment, reportedBy, and acceptanceCriteria. Tasks require a parent. Image attachments default to inline embedding.',
      inputSchema: {
        type: 'object',
        properties: {
          confirmed: { type: 'boolean', description: 'Must be true after explicit user confirmation' },
          type: { type: 'string', enum: ['User Story', 'Defect', 'Feature', 'Solution Capability', 'Task', 'Test Case'] },
          name: { type: 'string' },
          description: { type: 'string' },
          descriptionIsHtml: { type: 'boolean', default: false },
          workspace: { type: 'string' },
          project: { type: 'string' },
          owner: { type: 'string', description: 'Username, ObjectID, or user ref' },
          tags: { type: 'array', items: { type: 'string' } },
          attachments: { type: 'array', items: { type: 'string' }, description: 'Absolute local file paths' },
          embedImages: { type: 'boolean', default: true },
          severity: { type: 'string' },
          environment: { type: 'string' },
          reportedBy: { type: 'string' },
          acceptanceCriteria: { type: 'string' },
          parent: { type: 'string', description: 'Required for Task; parent FormattedID or ref' },
          additionalFields: { type: 'object', additionalProperties: true },
          kaiTaskId: { type: 'string', description: 'Optional existing Kai task ID to link to the new Rally item' },
        },
        required: ['confirmed', 'type', 'name', 'description'],
      },
      execute: safeTool(async (data) => {
        confirmed(data, 'Rally work item creation');
        const item = await deps.getClient().createWorkItem({
          type: String(data.type ?? ''),
          name: String(data.name ?? ''),
          description: String(data.description ?? ''),
          descriptionIsHtml: data.descriptionIsHtml === true,
          workspace: data.workspace as string | undefined,
          project: data.project as string | undefined,
          owner: data.owner as string | undefined,
          tags: stringArray(data.tags),
          attachments: stringArray(data.attachments),
          embedImages: data.embedImages !== false,
          severity: data.severity as string | undefined,
          environment: data.environment as string | undefined,
          reportedBy: data.reportedBy as string | undefined,
          acceptanceCriteria: data.acceptanceCriteria as string | undefined,
          parent: data.parent as string | undefined,
          additionalFields: data.additionalFields as Record<string, unknown> | undefined,
        });
        deps.api.state.emitEvent('work-item-created', {
          formattedId: item.formattedId,
          type: item.typeLabel,
          name: item.name,
        });
        const taskBoard = typeof data.kaiTaskId === 'string' && data.kaiTaskId.trim()
          ? await deps.sync.importToTaskBoard([item.formattedId], data.kaiTaskId.trim())
          : undefined;
        return { ...item, taskBoard };
      }),
    },
    {
      name: 'rally_update_work_item',
      description: 'Update fields on a Rally work item after the user confirms the exact target and changes. Use Rally field names such as Name, Description, Owner, Project, Severity, or AcceptanceCriteria.',
      inputSchema: {
        type: 'object',
        properties: {
          confirmed: { type: 'boolean', description: 'Must be true after explicit user confirmation' },
          formattedId: { type: 'string' },
          fields: { type: 'object', additionalProperties: true },
          descriptionIsHtml: { type: 'boolean', default: false },
          expectedLastUpdateDate: { type: 'string', description: 'Optional LastUpdateDate from the last read; mismatches return a conflict instead of overwriting' },
        },
        required: ['confirmed', 'formattedId', 'fields'],
      },
      execute: safeTool(async (data) => {
        confirmed(data, 'Rally work item update');
        const item = await deps.getClient().updateWorkItem(
          String(data.formattedId ?? ''),
          data.fields as Record<string, unknown>,
          data.descriptionIsHtml === true,
          data.expectedLastUpdateDate as string | undefined,
        );
        deps.api.state.emitEvent('work-item-updated', { formattedId: item.formattedId });
        return item;
      }, deps),
    },
    {
      name: 'rally_add_discussion',
      description: 'Add a discussion message to a Rally work item after the user confirms the target and message.',
      inputSchema: {
        type: 'object',
        properties: {
          confirmed: { type: 'boolean' },
          formattedId: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['confirmed', 'formattedId', 'message'],
      },
      execute: safeTool(async (data) => {
        confirmed(data, 'Rally discussion creation');
        return deps.getClient().addDiscussion(String(data.formattedId ?? ''), String(data.message ?? ''));
      }),
    },
    {
      name: 'rally_update_discussion',
      description: 'Edit an existing Rally discussion post after explicit confirmation.',
      inputSchema: {
        type: 'object',
        properties: {
          confirmed: { type: 'boolean' },
          objectId: { type: 'number' },
          message: { type: 'string' },
        },
        required: ['confirmed', 'objectId', 'message'],
      },
      execute: safeTool(async (data) => {
        confirmed(data, 'Rally discussion update');
        return deps.getClient().updateDiscussion(Number(data.objectId), String(data.message ?? ''));
      }),
    },
    {
      name: 'rally_manage_tags',
      description: 'Add or remove Rally tags after the user confirms the target and tag names. Missing tags are created when adding.',
      inputSchema: {
        type: 'object',
        properties: {
          confirmed: { type: 'boolean' },
          formattedId: { type: 'string' },
          mode: { type: 'string', enum: ['add', 'remove'] },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['confirmed', 'formattedId', 'mode', 'tags'],
      },
      execute: safeTool(async (data) => {
        confirmed(data, 'Rally tag update');
        return deps.getClient().manageTags(
          String(data.formattedId ?? ''),
          stringArray(data.tags),
          data.mode === 'remove' ? 'remove' : 'add',
        );
      }),
    },
    {
      name: 'rally_attach_files',
      description: 'Attach local files to a Rally work item after user confirmation. Images are embedded inline by default so they are visible in the description.',
      inputSchema: {
        type: 'object',
        properties: {
          confirmed: { type: 'boolean' },
          formattedId: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Absolute local file paths' },
          embedImages: { type: 'boolean', default: true },
        },
        required: ['confirmed', 'formattedId', 'paths'],
      },
      execute: safeTool(async (data) => {
        confirmed(data, 'Rally file attachment');
        return deps.getClient().attachFiles(
          String(data.formattedId ?? ''),
          stringArray(data.paths),
          data.embedImages !== false,
        );
      }),
    },
    {
      name: 'rally_update_state',
      description: 'Change a User Story/Defect schedule state or a Defect state after explicit user confirmation.',
      inputSchema: {
        type: 'object',
        properties: {
          confirmed: { type: 'boolean' },
          formattedId: { type: 'string' },
          scheduleState: { type: 'string', enum: [...SCHEDULE_STATES] },
          defectState: { type: 'string', enum: [...DEFECT_STATES] },
        },
        required: ['confirmed', 'formattedId'],
      },
      execute: safeTool(async (data) => {
        confirmed(data, 'Rally state update');
        return deps.getClient().updateState(String(data.formattedId ?? ''), {
          scheduleState: data.scheduleState as string | undefined,
          defectState: data.defectState as string | undefined,
        });
      }),
    },
    {
      name: 'rally_move_work_item',
      description: 'Move a Rally work item to a project, parent, portfolio item, iteration, or release, and optionally rank it above/below another item. Uses LastUpdateDate for conflict-safe updates when supplied.',
      inputSchema: {
        type: 'object',
        properties: {
          confirmed: { type: 'boolean' },
          formattedId: { type: 'string' },
          project: { type: ['string', 'null'] },
          parent: { type: ['string', 'null'] },
          portfolioItem: { type: ['string', 'null'] },
          iteration: { type: ['string', 'null'] },
          release: { type: ['string', 'null'] },
          rankAbove: { type: 'string', description: 'FormattedID or ref' },
          rankBelow: { type: 'string', description: 'FormattedID or ref' },
          expectedLastUpdateDate: { type: 'string' },
        },
        required: ['confirmed', 'formattedId'],
      },
      execute: safeTool(async (data) => {
        confirmed(data, 'Rally work item move');
        return deps.getClient().moveWorkItem(String(data.formattedId ?? ''), {
          project: data.project as string | null | undefined,
          parent: data.parent as string | null | undefined,
          portfolioItem: data.portfolioItem as string | null | undefined,
          iteration: data.iteration as string | null | undefined,
          release: data.release as string | null | undefined,
          rankAbove: data.rankAbove as string | undefined,
          rankBelow: data.rankBelow as string | undefined,
          expectedLastUpdateDate: data.expectedLastUpdateDate as string | undefined,
        });
      }, deps),
    },
    {
      name: 'rally_manage_dependencies',
      description: 'Add or remove predecessor/successor relationships for a Rally work item after explicit confirmation.',
      inputSchema: {
        type: 'object',
        properties: {
          confirmed: { type: 'boolean' },
          formattedId: { type: 'string' },
          direction: { type: 'string', enum: ['predecessors', 'successors'] },
          mode: { type: 'string', enum: ['add', 'remove'] },
          targets: { type: 'array', items: { type: 'string' }, description: 'FormattedIDs or refs' },
          expectedLastUpdateDate: { type: 'string' },
        },
        required: ['confirmed', 'formattedId', 'direction', 'mode', 'targets'],
      },
      execute: safeTool(async (data) => {
        confirmed(data, 'Rally dependency update');
        return deps.getClient().manageDependencies(
          String(data.formattedId ?? ''),
          data.direction === 'successors' ? 'successors' : 'predecessors',
          stringArray(data.targets),
          data.mode === 'remove' ? 'remove' : 'add',
          data.expectedLastUpdateDate as string | undefined,
        );
      }, deps),
    },
    {
      name: 'rally_manage_planning_item',
      description: 'Create or update a Rally iteration, release, or milestone after explicit confirmation.',
      inputSchema: {
        type: 'object',
        properties: {
          confirmed: { type: 'boolean' },
          operation: { type: 'string', enum: ['create', 'update'] },
          type: { type: 'string', enum: ['iteration', 'release', 'milestone'] },
          id: { type: ['string', 'number'] },
          fields: { type: 'object', additionalProperties: true },
          expectedLastUpdateDate: { type: 'string' },
        },
        required: ['confirmed', 'operation', 'type', 'fields'],
      },
      execute: safeTool(async (data) => {
        confirmed(data, 'Rally planning item mutation');
        return deps.getClient().mutatePlanningItem({
          operation: data.operation === 'update' ? 'update' : 'create',
          type: String(data.type ?? '') as 'iteration' | 'release' | 'milestone',
          id: data.id as string | number | undefined,
          fields: data.fields as Record<string, unknown>,
          expectedLastUpdateDate: data.expectedLastUpdateDate as string | undefined,
        });
      }, deps),
    },
    {
      name: 'rally_manage_capacity',
      description: 'Create or update Rally user iteration capacity after explicit confirmation.',
      inputSchema: {
        type: 'object',
        properties: {
          confirmed: { type: 'boolean' },
          operation: { type: 'string', enum: ['create', 'update'] },
          id: { type: ['string', 'number'] },
          fields: { type: 'object', additionalProperties: true, description: 'Capacity, User, Iteration, and optional Project refs/values' },
          expectedLastUpdateDate: { type: 'string' },
        },
        required: ['confirmed', 'operation', 'fields'],
      },
      execute: safeTool(async (data) => {
        confirmed(data, 'Rally capacity mutation');
        return deps.getClient().mutateCapacity({
          operation: data.operation === 'update' ? 'update' : 'create',
          id: data.id as string | number | undefined,
          fields: data.fields as Record<string, unknown>,
          expectedLastUpdateDate: data.expectedLastUpdateDate as string | undefined,
        });
      }, deps),
    },
    {
      name: 'rally_download_attachment',
      description: 'Download a Rally attachment to an absolute local path after explicit confirmation. Existing files are protected unless overwrite=true.',
      inputSchema: {
        type: 'object',
        properties: {
          confirmed: { type: 'boolean' },
          objectId: { type: 'number' },
          destinationPath: { type: 'string' },
          overwrite: { type: 'boolean', default: false },
        },
        required: ['confirmed', 'objectId', 'destinationPath'],
      },
      execute: safeTool(async (data) => {
        confirmed(data, 'Rally attachment download');
        return deps.getClient().downloadAttachment(
          Number(data.objectId),
          String(data.destinationPath ?? ''),
          data.overwrite === true,
        );
      }),
    },
    {
      name: 'rally_import_to_task_board',
      description: 'Add or refresh one or more Rally work items on the Kai Tasks/Kanban board after explicit confirmation. Existing external identities are updated idempotently.',
      inputSchema: {
        type: 'object',
        properties: {
          confirmed: { type: 'boolean' },
          formattedIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
          kaiTaskId: { type: 'string', description: 'Optional existing Kai task ID; only valid with one Rally FormattedID' },
        },
        required: ['confirmed', 'formattedIds'],
      },
      execute: safeTool(async (data) => {
        confirmed(data, 'Rally task-board import');
        return deps.sync.importToTaskBoard(
          stringArray(data.formattedIds),
          typeof data.kaiTaskId === 'string' ? data.kaiTaskId : undefined,
        );
      }),
    },
    {
      name: 'rally_manage_sync',
      description: 'Configure background Rally polling, Kai task-board mirroring, or saved watch queries after explicit confirmation.',
      inputSchema: {
        type: 'object',
        properties: {
          confirmed: { type: 'boolean' },
          action: { type: 'string', enum: ['configure', 'upsertWatch', 'removeWatch'] },
          enabled: { type: 'boolean' },
          intervalSeconds: { type: 'number', minimum: 30 },
          notifications: { type: 'boolean' },
          notifyOnNew: { type: 'boolean' },
          notifyOnUpdated: { type: 'boolean' },
          maxItemsPerWatch: { type: 'number', minimum: 1, maximum: 1000 },
          taskBoardEnabled: { type: 'boolean', description: 'Mirror items matched by enabled watches into Kai Tasks' },
          taskBoardBidirectional: { type: 'boolean', description: 'Push linked task title, description, and status edits back to Rally' },
          taskBoardArchiveMissing: { type: 'boolean', description: 'Archive mirrored cards that no longer match any complete watch result' },
          id: { type: 'string' },
          name: { type: 'string' },
          query: { type: 'string' },
          workspace: { type: 'string' },
          projects: { type: 'array', items: { type: 'string' } },
          types: { type: 'array', items: { type: 'string' } },
          order: { type: 'string' },
          projectScopeUp: { type: 'boolean' },
          projectScopeDown: { type: 'boolean' },
        },
        required: ['confirmed', 'action'],
      },
      execute: safeTool(async (data) => {
        confirmed(data, 'Rally sync configuration');
        if (data.action === 'removeWatch') return deps.sync.removeWatch(String(data.id ?? ''));
        if (data.action === 'upsertWatch') {
          return deps.sync.upsertWatch({
            id: data.id as string | undefined,
            name: data.name as string | undefined,
            query: String(data.query ?? ''),
            workspace: data.workspace as string | undefined,
            projects: stringArray(data.projects),
            types: stringArray(data.types),
            order: data.order as string | undefined,
            enabled: data.enabled !== false,
            projectScopeUp: data.projectScopeUp === true,
            projectScopeDown: data.projectScopeDown === true,
          });
        }
        const current = deps.sync.getSettings();
        return deps.sync.saveSettings({
          enabled: typeof data.enabled === 'boolean' ? data.enabled : current.enabled,
          intervalSeconds: typeof data.intervalSeconds === 'number' ? data.intervalSeconds : current.intervalSeconds,
          notifications: typeof data.notifications === 'boolean' ? data.notifications : current.notifications,
          notifyOnNew: typeof data.notifyOnNew === 'boolean' ? data.notifyOnNew : current.notifyOnNew,
          notifyOnUpdated: typeof data.notifyOnUpdated === 'boolean' ? data.notifyOnUpdated : current.notifyOnUpdated,
          maxItemsPerWatch: typeof data.maxItemsPerWatch === 'number' ? data.maxItemsPerWatch : current.maxItemsPerWatch,
          taskBoard: {
            enabled: typeof data.taskBoardEnabled === 'boolean' ? data.taskBoardEnabled : current.taskBoard.enabled,
            bidirectional: typeof data.taskBoardBidirectional === 'boolean'
              ? data.taskBoardBidirectional
              : current.taskBoard.bidirectional,
            archiveMissing: typeof data.taskBoardArchiveMissing === 'boolean'
              ? data.taskBoardArchiveMissing
              : current.taskBoard.archiveMissing,
          },
        });
      }),
    },
  ];
}

function rawTools(deps: ToolDependencies): Tool[] {
  return [{
    name: 'rally_wsapi_request',
    description: 'Call an arbitrary same-origin Rally WSAPI v2.0 path. GET is read-only. POST/PUT/PATCH require explicit user confirmation. DELETE is handled by the separately gated delete tool.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH'] },
        path: { type: 'string', description: 'Same-origin WSAPI path or Rally ref' },
        params: { type: 'object', additionalProperties: true },
        data: { type: 'object', additionalProperties: true },
        confirmed: { type: 'boolean', description: 'Required for non-GET requests' },
      },
      required: ['path'],
    },
    execute: safeTool(async (data) => {
      const method = String(data.method ?? 'GET').toUpperCase();
      if (method !== 'GET') confirmed(data, `Rally ${method} request`);
      return deps.getClient().request(String(data.path ?? ''), {
        method,
        params: data.params as Record<string, string | number | boolean | undefined> | undefined,
        body: data.data,
      });
    }),
  }];
}

function deleteTools(deps: ToolDependencies): Tool[] {
  return [
    {
      name: 'rally_delete_object',
      description: 'Permanently delete a Rally object. Use only after the user explicitly confirms the exact object type and ObjectID. This operation cannot be undone.',
      inputSchema: {
        type: 'object',
        properties: {
          confirmed: { type: 'boolean', description: 'Must be true after explicit user confirmation' },
          type: { type: 'string', description: 'Rally entity type or path' },
          id: { type: ['string', 'number'], description: 'Rally ObjectID' },
        },
        required: ['confirmed', 'type', 'id'],
      },
      execute: safeTool(async (data) => {
        confirmed(data, 'Rally deletion');
        return deps.getClient().genericEntityOperation({
          operation: 'delete',
          type: String(data.type ?? ''),
          id: data.id as string | number,
        });
      }),
    },
    {
      name: 'rally_delete_attachment',
      description: 'Permanently delete a Rally attachment after explicit confirmation of its ObjectID.',
      inputSchema: {
        type: 'object',
        properties: {
          confirmed: { type: 'boolean' },
          objectId: { type: 'number' },
        },
        required: ['confirmed', 'objectId'],
      },
      execute: safeTool(async (data) => {
        confirmed(data, 'Rally attachment deletion');
        return deps.getClient().deleteAttachment(Number(data.objectId));
      }),
    },
    {
      name: 'rally_delete_discussion',
      description: 'Permanently delete a Rally discussion post after explicit confirmation of its ObjectID.',
      inputSchema: {
        type: 'object',
        properties: {
          confirmed: { type: 'boolean' },
          objectId: { type: 'number' },
        },
        required: ['confirmed', 'objectId'],
      },
      execute: safeTool(async (data) => {
        confirmed(data, 'Rally discussion deletion');
        return deps.getClient().deleteDiscussion(Number(data.objectId));
      }),
    },
  ];
}

export function registerTools(deps: ToolDependencies, permissions: ToolPermissions): void {
  const tools: Tool[] = [];
  if (permissions.read) tools.push(...readTools(deps));
  if (permissions.write) tools.push(...writeTools(deps));
  if (permissions.rawRequest) tools.push(...rawTools(deps));
  if (permissions.delete) tools.push(...deleteTools(deps));
  deps.api.tools.unregister([...ALL_TOOL_NAMES]);
  if (tools.length) deps.api.tools.register(tools);
  deps.api.log.info(`Registered ${tools.length} Rally tools.`);
}
