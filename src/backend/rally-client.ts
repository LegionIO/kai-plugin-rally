import { basename } from 'node:path';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { marked } from 'marked';
import {
  DEFAULT_FETCH_FIELDS,
  WORK_ITEM_TYPES,
} from '../shared/constants.js';
import type {
  PluginAPI,
  PagedResult,
  PageOptions,
  PlanningItem,
  PlanningItemType,
  ProjectOption,
  RallyContext,
  RallyRef,
  SearchWorkItemsOptions,
  TokenRecord,
  WorkItem,
  WorkItemType,
  WorkspaceOption,
} from '../shared/types.js';

type RequestOptions = {
  method?: string;
  params?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

type QueryResult<T> = {
  QueryResult?: {
    Results?: T[];
    Errors?: string[];
    TotalResultCount?: number;
    StartIndex?: number;
    PageSize?: number;
    Warnings?: string[];
  };
};

type OperationResult<T = Record<string, unknown>> = {
  CreateResult?: { Object?: T; Errors?: string[] };
  OperationResult?: { Object?: T; Errors?: string[] };
};

export type CreateWorkItemInput = {
  type: string;
  name: string;
  description: string;
  descriptionIsHtml?: boolean;
  workspace?: string;
  project?: string;
  owner?: string;
  tags?: string[];
  attachments?: string[];
  embedImages?: boolean;
  severity?: string;
  environment?: string;
  reportedBy?: string;
  acceptanceCriteria?: string;
  parent?: string;
  additionalFields?: Record<string, unknown>;
};

export type WorkItemCollections = {
  discussions: PagedResult<Record<string, unknown>>;
  attachments: PagedResult<Record<string, unknown>>;
  tags: PagedResult<Record<string, unknown>>;
  revisions: PagedResult<Record<string, unknown>>;
};

export class RallyConflictError extends Error {
  constructor(
    message: string,
    readonly conflict: {
      formattedId: string;
      operation: string;
      expectedLastUpdateDate: string;
      actualLastUpdateDate?: string;
    },
  ) {
    super(message);
    this.name = 'RallyConflictError';
  }
}

const TYPE_ALIASES: Record<string, WorkItemType> = {
  'user story': 'HierarchicalRequirement',
  userstory: 'HierarchicalRequirement',
  us: 'HierarchicalRequirement',
  hierarchicalrequirement: 'HierarchicalRequirement',
  defect: 'Defect',
  bug: 'Defect',
  feature: 'PortfolioItem/Feature',
  'portfolioitem/feature': 'PortfolioItem/Feature',
  capability: 'PortfolioItem/SolutionCapability',
  'solution capability': 'PortfolioItem/SolutionCapability',
  solutioncapability: 'PortfolioItem/SolutionCapability',
  'portfolioitem/solutioncapability': 'PortfolioItem/SolutionCapability',
  task: 'Task',
  testcase: 'TestCase',
  'test case': 'TestCase',
};

function collectRallyErrors(value: unknown, errors: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const child of value) collectRallyErrors(child, errors);
    return errors;
  }
  if (!value || typeof value !== 'object') return errors;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'Errors' && Array.isArray(child)) {
      for (const error of child) {
        const message = String(error).trim();
        if (message) errors.push(message);
      }
    } else {
      collectRallyErrors(child, errors);
    }
  }
  return errors;
}

function normalizeHtml(value: string, preserveHtml = false): string {
  const decoded = value.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\r/g, '\n');
  if (preserveHtml || /<[^>]+>/.test(decoded)) return decoded;
  const html = marked.parse(decoded, { async: false, breaks: true, gfm: true }) as string;
  return html.trim().replace(/^<p>(.*)<\/p>$/s, '$1');
}

function escapeQueryValue(value: string): string {
  return value.replace(/"/g, '\\"');
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function extractObjectId(ref?: string): number | undefined {
  const match = ref?.match(/\/(\d+)(?:\.json)?$/);
  return match ? Number(match[1]) : undefined;
}

function contentType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.txt') || lower.endsWith('.log')) return 'text/plain';
  return 'application/octet-stream';
}

function isImage(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(path);
}

function positiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.trunc(value!), max));
}

function normalizeOrder(value?: string, fallback = 'LastUpdateDate DESC'): string {
  const order = (value?.trim() || fallback).replace(/\s+/g, ' ');
  const parts = order.split(',').map((part) => part.trim()).filter(Boolean);
  if (!parts.length || parts.some((part) => !/^[A-Za-z][A-Za-z0-9_.]*(?:\s+(?:ASC|DESC))?$/i.test(part))) {
    throw new Error(`Invalid Rally order expression: ${value}`);
  }
  return parts.map((part) => {
    const [field, direction = 'ASC'] = part.split(' ');
    return `${field} ${direction.toUpperCase()}`;
  }).join(',');
}

function comparable(value: unknown): string | number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const time = Date.parse(value);
    if (/date/i.test(value) || (!Number.isNaN(time) && /^\d{4}-\d{2}-\d{2}/.test(value))) return time;
    const numeric = Number(value);
    if (value.trim() && Number.isFinite(numeric)) return numeric;
    return value.toLocaleLowerCase();
  }
  return String(value ?? '').toLocaleLowerCase();
}

function compareByOrder(a: Record<string, unknown>, b: Record<string, unknown>, order: string): number {
  for (const expression of order.split(',')) {
    const [field, direction] = expression.trim().split(' ');
    const av = comparable(a[field]);
    const bv = comparable(b[field]);
    const compared = typeof av === 'number' && typeof bv === 'number'
      ? av - bv
      : String(av).localeCompare(String(bv));
    if (compared) return direction === 'DESC' ? -compared : compared;
  }
  return 0;
}

function unwrapRecord(payload: unknown, preferredKeys: string[] = []): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const record = payload as Record<string, unknown>;
  for (const key of preferredKeys) {
    const value = record[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  const objectValues = Object.values(record).filter((value) => value && typeof value === 'object' && !Array.isArray(value));
  if (objectValues.length === 1) return objectValues[0] as Record<string, unknown>;
  return record;
}

function collectionRef(value: unknown): string | undefined {
  return value && typeof value === 'object' && typeof (value as { _ref?: unknown })._ref === 'string'
    ? (value as { _ref: string })._ref
    : undefined;
}

export function resolveWorkItemType(value: string): WorkItemType {
  const normalized = value.trim().toLowerCase().replace(/[_-]+/g, ' ');
  const compact = normalized.replace(/\s+/g, '');
  const type = TYPE_ALIASES[normalized] ?? TYPE_ALIASES[compact];
  if (!type) {
    throw new Error(`Unsupported Rally work item type: ${value}`);
  }
  return type;
}

export function typeFromFormattedId(formattedId: string): WorkItemType {
  const upper = formattedId.trim().toUpperCase();
  const entries = Object.entries(WORK_ITEM_TYPES) as Array<[
    WorkItemType,
    (typeof WORK_ITEM_TYPES)[WorkItemType],
  ]>;
  for (const [type, details] of entries) {
    if (details.prefixes.some((prefix) => upper.startsWith(prefix))) return type;
  }
  throw new Error(`Unable to determine Rally type from FormattedID: ${formattedId}`);
}

export class RallyClient {
  private readonly baseUrl: string;
  private readonly apiBase: string;

  constructor(
    private readonly api: PluginAPI,
    private readonly token: TokenRecord,
    private readonly context: RallyContext = {},
  ) {
    const base = new URL(`${token.baseUrl}/`);
    if (base.protocol !== 'https:') throw new Error('Rally base URL must use HTTPS.');
    this.baseUrl = base.toString().replace(/\/$/, '');
    this.apiBase = `${this.baseUrl}/slm/webservice/v2.0`;
  }

  private safeUrl(pathOrUrl: string): URL {
    const url = new URL(pathOrUrl, `${this.apiBase}/`);
    if (url.origin !== new URL(this.baseUrl).origin) {
      throw new Error(`Refusing to send the Rally OAuth token to another origin: ${url.origin}`);
    }
    return url;
  }

  private authHeaders(): Record<string, string> {
    return {
      Accept: 'application/json',
      ZSESSIONID: this.token.accessToken,
      'X-RallyIntegrationName': 'kai-plugin-rally',
      'X-RallyIntegrationVendor': 'Kai Desktop',
      'X-RallyIntegrationVersion': '0.3.2',
    };
  }

  private assertTokenValid(): void {
    if (this.token.expiresAt && Date.parse(this.token.expiresAt) <= Date.now()) {
      throw new Error('The Rally OAuth token has expired. Authorize Kai again.');
    }
  }

  async request<T = unknown>(pathOrUrl: string, options: RequestOptions = {}): Promise<T> {
    this.assertTokenValid();
    const url = this.safeUrl(pathOrUrl);
    for (const [key, value] of Object.entries(options.params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers = this.authHeaders();
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const response = await this.api.fetch(url.toString(), {
      method: options.method ?? 'GET',
      headers,
      body,
    });
    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!response.ok) {
      const detail = typeof payload === 'string' ? payload.slice(0, 500) : JSON.stringify(payload);
      throw new Error(`Rally request failed (${response.status} ${response.statusText}): ${detail}`);
    }
    const errors = collectRallyErrors(payload);
    if (errors.length) throw new Error(`Rally returned errors: ${errors.join('; ')}`);
    return payload as T;
  }

  async requestBytes(pathOrUrl: string): Promise<Uint8Array> {
    this.assertTokenValid();
    const url = this.safeUrl(pathOrUrl);
    const response = await this.api.fetch(url.toString(), { headers: this.authHeaders() });
    if (!response.ok) {
      throw new Error(`Rally download failed (${response.status} ${response.statusText}).`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async verify(): Promise<void> {
    await this.request('subscription', { params: { fetch: 'Name,ObjectID', pagesize: 1 } });
  }

  private async fetchAll<T>(path: string, params: Record<string, string | undefined>): Promise<T[]> {
    const results: T[] = [];
    let start = 1;
    while (true) {
      const payload = await this.request<QueryResult<T>>(path, {
        params: { ...params, pagesize: 200, start },
      });
      const page = payload.QueryResult?.Results ?? [];
      results.push(...page);
      if (page.length < 200) break;
      start += page.length;
    }
    return results;
  }

  async listWorkspaces(): Promise<WorkspaceOption[]> {
    const values = await this.fetchAll<RallyRef>('workspace', { fetch: 'Name,ObjectID' });
    return values
      .map((item) => {
        const objectId = item.ObjectID ?? extractObjectId(item._ref) ?? 0;
        return {
          objectId,
          name: item.Name ?? item._refObjectName ?? `Workspace ${objectId}`,
          ref: item._ref ?? `${this.apiBase}/workspace/${objectId}`,
        };
      })
      .filter((item) => item.objectId > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listProjects(workspace = this.context.workspaceRef): Promise<ProjectOption[]> {
    const workspaceRef = await this.resolveWorkspaceRef(workspace);
    if (!workspaceRef) throw new Error('Select a Rally workspace first.');
    const values = await this.fetchAll<RallyRef & { Parent?: RallyRef | null }>('project', {
      fetch: 'Name,ObjectID,Parent',
      workspace: workspaceRef,
    });
    return values
      .map((item) => {
        const objectId = item.ObjectID ?? extractObjectId(item._ref) ?? 0;
        return {
          objectId,
          name: item.Name ?? item._refObjectName ?? `Project ${objectId}`,
          ref: item._ref ?? `${this.apiBase}/project/${objectId}`,
          parentRef: item.Parent?._ref,
          parentObjectId: item.Parent?.ObjectID ?? extractObjectId(item.Parent?._ref),
          parentName: item.Parent?.Name ?? item.Parent?._refObjectName,
        };
      })
      .filter((item) => item.objectId > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async resolveWorkspaceRef(value?: string): Promise<string | undefined> {
    if (!value) return undefined;
    if (/^https?:\/\//i.test(value) || value.includes('/workspace/')) return value;
    if (/^\d+$/.test(value)) return `${this.apiBase}/workspace/${value}`;
    const result = await this.request<QueryResult<RallyRef>>('workspace', {
      params: {
        query: `(Name = "${escapeQueryValue(value)}")`,
        fetch: 'ObjectID,Name',
        pagesize: 1,
      },
    });
    const workspace = result.QueryResult?.Results?.[0];
    if (!workspace) throw new Error(`Workspace not found: ${value}`);
    return workspace._ref ?? `${this.apiBase}/workspace/${workspace.ObjectID}`;
  }

  async resolveProjectRef(value?: string, workspace = this.context.workspaceRef): Promise<string | undefined> {
    if (!value) return undefined;
    if (/^https?:\/\//i.test(value) || value.includes('/project/')) return value;
    if (/^\d+$/.test(value)) return `${this.apiBase}/project/${value}`;
    const workspaceRef = await this.resolveWorkspaceRef(workspace);
    const result = await this.request<QueryResult<RallyRef>>('project', {
      params: {
        query: `(Name = "${escapeQueryValue(value)}")`,
        fetch: 'ObjectID,Name',
        pagesize: 1,
        workspace: workspaceRef,
      },
    });
    const project = result.QueryResult?.Results?.[0];
    if (!project) throw new Error(`Project not found: ${value}`);
    return project._ref ?? `${this.apiBase}/project/${project.ObjectID}`;
  }

  private workItemUrl(type: WorkItemType, objectId: number): string {
    return `${this.baseUrl}/#/?detail=/${type.toLowerCase()}/${objectId}`;
  }

  private toWorkItem(type: WorkItemType, raw: Record<string, unknown>): WorkItem {
    const objectId = Number(raw.ObjectID ?? 0);
    const ref = String(raw._ref ?? `${this.apiBase}/${WORK_ITEM_TYPES[type].path}/${objectId}`);
    return {
      type,
      typeLabel: WORK_ITEM_TYPES[type].label,
      objectId,
      formattedId: String(raw.FormattedID ?? ''),
      name: String(raw.Name ?? ''),
      description: typeof raw.Description === 'string' ? raw.Description : undefined,
      notes: typeof raw.Notes === 'string' ? raw.Notes : undefined,
      scheduleState: typeof raw.ScheduleState === 'string' ? raw.ScheduleState : undefined,
      state: typeof raw.State === 'string' ? raw.State : undefined,
      project: raw.Project as RallyRef | undefined,
      workspace: raw.Workspace as RallyRef | undefined,
      owner: raw.Owner as WorkItem['owner'],
      tags: raw.Tags,
      attachments: raw.Attachments,
      discussion: raw.Discussion,
      revisionHistory: raw.RevisionHistory,
      parent: raw.Parent as RallyRef | undefined,
      workProduct: raw.WorkProduct as RallyRef | undefined,
      portfolioItem: raw.PortfolioItem as RallyRef | undefined,
      iteration: raw.Iteration as RallyRef | undefined,
      release: raw.Release as RallyRef | undefined,
      rank: typeof raw.DragAndDropRank === 'string' || typeof raw.DragAndDropRank === 'number'
        ? raw.DragAndDropRank
        : undefined,
      creationDate: typeof raw.CreationDate === 'string' ? raw.CreationDate : undefined,
      lastUpdateDate: typeof raw.LastUpdateDate === 'string' ? raw.LastUpdateDate : undefined,
      ref,
      url: this.workItemUrl(type, objectId),
      raw,
    };
  }

  async searchWorkItemsPage(
    query: string,
    options: SearchWorkItemsOptions = {},
  ): Promise<PagedResult<WorkItem>> {
    if (!query.trim()) throw new Error('A Rally WSAPI query is required.');
    const workspace = await this.resolveWorkspaceRef(options.workspace ?? this.context.workspaceRef);
    const requestedProjects = options.projects?.length
      ? [...new Set(options.projects.map((value) => value.trim()).filter(Boolean))]
      : options.project
        ? [options.project]
        : this.context.projectRef
          ? [this.context.projectRef]
          : [];
    const projects = requestedProjects.length
      ? await Promise.all(requestedProjects.map((value) => this.resolveProjectRef(value, workspace)))
      : [undefined];
    const types = options.types?.length
      ? [...new Set(options.types.map(resolveWorkItemType))]
      : (Object.keys(WORK_ITEM_TYPES) as WorkItemType[]);
    const page = positiveInteger(options.page, 1, 10_000);
    const pageSize = positiveInteger(options.pageSize, 50, 200);
    const order = normalizeOrder(options.order);
    const required = page * pageSize;
    const warnings: string[] = [];

    const batches = await Promise.all(types.flatMap((type) => projects.map(async (project) => {
      const values: Record<string, unknown>[] = [];
      let start = 1;
      let total = 0;
      while (values.length < required) {
        const requestSize = Math.min(200, required - values.length);
        const payload = await this.request<QueryResult<Record<string, unknown>>>(WORK_ITEM_TYPES[type].path, {
          params: {
            query,
            fetch: DEFAULT_FETCH_FIELDS,
            pagesize: requestSize,
            start,
            order,
            workspace,
            project,
            projectScopeUp: options.projectScopeUp ?? false,
            projectScopeDown: options.projectScopeDown ?? false,
          },
        });
        const result = payload.QueryResult;
        const current = result?.Results ?? [];
        total = result?.TotalResultCount ?? current.length;
        if (result?.Warnings?.length) warnings.push(...result.Warnings);
        values.push(...current);
        if (!current.length || values.length >= total) break;
        start += current.length;
      }
      return { type, project, values, total };
    })));

    const unique = new Map<string, WorkItem>();
    for (const batch of batches) {
      for (const raw of batch.values) {
        const item = this.toWorkItem(batch.type, raw);
        const key = item.ref || `${item.type}:${item.objectId}`;
        const existing = unique.get(key);
        if (!existing || (item.lastUpdateDate ?? '') > (existing.lastUpdateDate ?? '')) unique.set(key, item);
      }
    }
    const all = [...unique.values()].sort((a, b) => compareByOrder(a.raw ?? {}, b.raw ?? {}, order));
    const offset = (page - 1) * pageSize;
    const summedTotal = batches.reduce((sum, batch) => sum + batch.total, 0);
    if (projects.length > 1 && (options.projectScopeUp || options.projectScopeDown)) {
      warnings.push('Total result count may include overlapping scoped project results; returned items are de-duplicated.');
    }
    return {
      items: all.slice(offset, offset + pageSize),
      page,
      pageSize,
      total: Math.max(all.length, summedTotal),
      hasMore: summedTotal > offset + pageSize || all.length > offset + pageSize,
      order,
      warnings: [...new Set(warnings)],
    };
  }

  async searchWorkItems(
    query: string,
    options: SearchWorkItemsOptions & { limit?: number } = {},
  ): Promise<WorkItem[]> {
    const page = await this.searchWorkItemsPage(query, {
      ...options,
      page: 1,
      pageSize: options.limit ?? options.pageSize,
    });
    return page.items;
  }

  async getWorkItem(formattedId: string): Promise<WorkItem> {
    const type = typeFromFormattedId(formattedId);
    const normalized = formattedId.trim().toUpperCase();
    const results = await this.searchWorkItems(
      `(FormattedID = "${escapeQueryValue(normalized)}")`,
      { types: [type], limit: 1 },
    );
    if (results[0]) return results[0];
    // A selected project must not prevent opening a result returned by a multi-project search.
    const workspace = await this.resolveWorkspaceRef(this.context.workspaceRef);
    const response = await this.request<QueryResult<Record<string, unknown>>>(WORK_ITEM_TYPES[type].path, {
      params: {
        query: `(FormattedID = "${escapeQueryValue(normalized)}")`,
        fetch: DEFAULT_FETCH_FIELDS,
        pagesize: 1,
        workspace,
      },
    });
    const raw = response.QueryResult?.Results?.[0];
    if (!raw) throw new Error(`No Rally work item found with FormattedID ${formattedId}.`);
    return this.toWorkItem(type, raw);
  }

  private async resolveOwnerRef(owner: string): Promise<string> {
    const value = owner.trim();
    if (!value) throw new Error('Owner cannot be empty.');
    if (/^https?:\/\//i.test(value) || value.includes('/user/')) return value;
    if (/^\d+$/.test(value)) return `${this.apiBase}/user/${value}`;
    const payload = await this.request<QueryResult<RallyRef & { UserName?: string }>>('user', {
      params: {
        query: `(UserName = "${escapeQueryValue(value)}")`,
        fetch: 'ObjectID,UserName',
        pagesize: 1,
      },
    });
    const user = payload.QueryResult?.Results?.[0];
    if (!user) throw new Error(`Rally user not found: ${owner}`);
    return user._ref ?? `${this.apiBase}/user/${user.ObjectID}`;
  }

  async createWorkItem(input: CreateWorkItemInput): Promise<WorkItem & { attached?: string[] }> {
    const type = resolveWorkItemType(input.type);
    if (!input.name.trim()) throw new Error('Work item name is required.');
    if (type === 'Defect') {
      const missing = [
        ['severity', input.severity],
        ['environment', input.environment],
        ['reportedBy', input.reportedBy],
        ['acceptanceCriteria', input.acceptanceCriteria],
      ].filter(([, value]) => !value).map(([name]) => name);
      if (missing.length) throw new Error(`Defect creation requires: ${missing.join(', ')}.`);
    }
    if (type === 'Task' && !input.parent) {
      throw new Error('Task creation requires a parent WorkProduct FormattedID or ref.');
    }
    const workspace = await this.resolveWorkspaceRef(input.workspace ?? this.context.workspaceRef);
    const project = await this.resolveProjectRef(input.project ?? this.context.projectRef, workspace);
    const fields: Record<string, unknown> = {
      Name: input.name.trim(),
      Description: normalizeHtml(input.description, input.descriptionIsHtml),
      ...input.additionalFields,
    };
    if (workspace) fields.Workspace = { _ref: workspace };
    if (project) fields.Project = { _ref: project };
    if (input.owner) fields.Owner = { _ref: await this.resolveOwnerRef(input.owner) };
    if (input.severity) fields.Severity = input.severity;
    if (input.environment) fields.Environment = input.environment;
    if (input.reportedBy) fields.ReportedBy = input.reportedBy;
    if (input.acceptanceCriteria) fields.AcceptanceCriteria = normalizeHtml(input.acceptanceCriteria);
    if (input.parent) {
      const parent = input.parent.includes('/')
        ? input.parent
        : (await this.getWorkItem(input.parent)).ref;
      fields.WorkProduct = { _ref: parent };
    }

    const response = await this.request<OperationResult<Record<string, unknown>>>(
      `${WORK_ITEM_TYPES[type].path}/create`,
      { method: 'POST', body: { [type]: fields } },
    );
    const raw = response.CreateResult?.Object;
    if (!raw?.FormattedID || !raw.ObjectID) throw new Error('Rally created the item but returned no ID.');
    const formattedId = String(raw.FormattedID);
    if (input.tags?.length) await this.manageTags(formattedId, input.tags, 'add');
    let attached: string[] | undefined;
    if (input.attachments?.length) {
      const result = await this.attachFiles(formattedId, input.attachments, Boolean(input.embedImages));
      attached = result.attachments.map((item) => item.name);
    }
    const created = await this.getWorkItem(formattedId);
    return { ...created, attached };
  }

  async updateWorkItem(
    formattedId: string,
    fields: Record<string, unknown>,
    descriptionIsHtml = false,
    expectedLastUpdateDate?: string,
    requestParams?: Record<string, string | number | boolean | undefined>,
  ): Promise<WorkItem> {
    const item = await this.getWorkItem(formattedId);
    this.assertUnchanged(item, expectedLastUpdateDate, 'update');
    const update = { ...fields };
    if (typeof update.Description === 'string') {
      update.Description = normalizeHtml(update.Description, descriptionIsHtml);
    }
    await this.request(`${WORK_ITEM_TYPES[item.type].path}/${item.objectId}`, {
      method: 'POST',
      body: { [item.type]: update },
      params: requestParams,
    });
    return this.getWorkItem(formattedId);
  }

  private assertUnchanged(item: WorkItem, expected: string | undefined, operation: string): void {
    if (!expected) return;
    const actual = item.lastUpdateDate;
    if (!actual || Date.parse(actual) !== Date.parse(expected)) {
      throw new RallyConflictError(
        `${item.formattedId} changed in Rally after it was read. Refresh it before ${operation}.`,
        {
          formattedId: item.formattedId,
          operation,
          expectedLastUpdateDate: expected,
          actualLastUpdateDate: actual,
        },
      );
    }
  }

  async addDiscussion(formattedId: string, message: string): Promise<{ objectId: number }> {
    const item = await this.getWorkItem(formattedId);
    const response = await this.request<OperationResult<{ ObjectID?: number }>>('conversationpost/create', {
      method: 'POST',
      body: { ConversationPost: { Artifact: { _ref: item.ref }, Text: message } },
    });
    const objectId = Number(response.CreateResult?.Object?.ObjectID ?? 0);
    if (!objectId) throw new Error('Rally did not return a discussion ObjectID.');
    return { objectId };
  }

  async updateDiscussion(objectId: number, message: string): Promise<Record<string, unknown>> {
    if (!message.trim()) throw new Error('Discussion message cannot be empty.');
    return this.request(`conversationpost/${objectId}`, {
      method: 'POST',
      body: { ConversationPost: { Text: message } },
    });
  }

  async deleteDiscussion(objectId: number): Promise<{ deleted: number }> {
    await this.request(`conversationpost/${objectId}`, { method: 'DELETE' });
    return { deleted: objectId };
  }

  async collectionPage<T extends Record<string, unknown>>(
    ref: string | undefined,
    options: PageOptions = {},
    fetch?: string,
  ): Promise<PagedResult<T>> {
    const page = positiveInteger(options.page, 1, 10_000);
    const pageSize = positiveInteger(options.pageSize, 50, 200);
    const order = options.order ? normalizeOrder(options.order, options.order) : undefined;
    if (!ref) return { items: [], page, pageSize, total: 0, hasMore: false, order };
    const response = await this.request<QueryResult<T>>(ref, {
      params: {
        pagesize: pageSize,
        start: (page - 1) * pageSize + 1,
        order,
        fetch,
      },
    });
    const query = response.QueryResult;
    const items = query?.Results ?? [];
    const total = query?.TotalResultCount ?? items.length;
    return {
      items,
      page,
      pageSize,
      total,
      hasMore: page * pageSize < total,
      order,
      warnings: query?.Warnings,
    };
  }

  private async collection<T>(ref?: string): Promise<T[]> {
    if (!ref) return [];
    const response = await this.request<QueryResult<T>>(ref, { params: { pagesize: 200 } });
    return response.QueryResult?.Results ?? [];
  }

  async getWorkItemCollections(
    formattedId: string,
    options: PageOptions = {},
  ): Promise<WorkItemCollections> {
    const item = await this.getWorkItem(formattedId);
    const raw = item.raw ?? {};
    const revisionHistoryRef = collectionRef(raw.RevisionHistory);
    let revisionsRef: string | undefined;
    if (revisionHistoryRef) {
      const response = await this.request<Record<string, unknown>>(revisionHistoryRef, {
        params: { fetch: 'Revisions' },
      });
      const history = unwrapRecord(response, ['RevisionHistory']);
      revisionsRef = collectionRef(history.Revisions);
    }
    const [discussions, attachments, tags, revisions] = await Promise.all([
      this.collectionPage<Record<string, unknown>>(
        collectionRef(raw.Discussion),
        options,
        'ObjectID,Text,CreationDate,User,Artifact,_ref',
      ),
      this.collectionPage<Record<string, unknown>>(
        collectionRef(raw.Attachments),
        options,
        'ObjectID,Name,ContentType,Size,CreationDate,User,Content,_ref',
      ),
      this.collectionPage<Record<string, unknown>>(
        collectionRef(raw.Tags),
        options,
        'ObjectID,Name,_ref',
      ),
      this.collectionPage<Record<string, unknown>>(
        revisionsRef,
        options,
        'ObjectID,RevisionNumber,CreationDate,User,Description,_ref',
      ),
    ]);
    return { discussions, attachments, tags, revisions };
  }

  async downloadAttachment(
    objectId: number,
    destinationPath: string,
    overwrite = false,
  ): Promise<{ objectId: number; name: string; path: string; bytes: number }> {
    if (!Number.isFinite(objectId) || objectId <= 0) throw new Error('A valid attachment ObjectID is required.');
    if (!destinationPath.trim() || !isAbsolute(destinationPath)) {
      throw new Error('Attachment destinationPath must be an absolute local path.');
    }
    const attachmentPayload = await this.request<Record<string, unknown>>(`attachment/${objectId}`, {
      params: { fetch: 'ObjectID,Name,Size,Content,ContentType' },
    });
    const attachment = unwrapRecord(attachmentPayload, ['Attachment']);
    const name = basename(String(attachment.Name ?? `attachment-${objectId}`));
    const contentRef = collectionRef(attachment.Content);
    if (!contentRef) throw new Error(`Attachment ${objectId} did not include content.`);
    const contentPayload = await this.request<Record<string, unknown>>(contentRef, {
      params: { fetch: 'Content,ObjectID' },
    });
    const content = unwrapRecord(contentPayload, ['AttachmentContent']);
    if (typeof content.Content !== 'string') throw new Error(`Attachment ${objectId} returned no base64 content.`);
    const bytes = Buffer.from(content.Content, 'base64');
    const candidate = resolve(destinationPath);
    const outputPath = existsSync(candidate) && statSync(candidate).isDirectory()
      ? resolve(candidate, name)
      : candidate;
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, bytes, { flag: overwrite ? 'w' : 'wx' });
    return { objectId, name, path: outputPath, bytes: bytes.length };
  }

  async deleteAttachment(objectId: number): Promise<{ deleted: number }> {
    await this.request(`attachment/${objectId}`, { method: 'DELETE' });
    return { deleted: objectId };
  }

  private async resolveTagRef(name: string): Promise<string> {
    const response = await this.request<QueryResult<RallyRef>>('tag', {
      params: {
        query: `(Name = "${escapeQueryValue(name)}")`,
        fetch: 'ObjectID,Name',
        pagesize: 1,
      },
    });
    const existing = response.QueryResult?.Results?.[0];
    if (existing) return existing._ref ?? `${this.apiBase}/tag/${existing.ObjectID}`;
    const created = await this.request<OperationResult<RallyRef>>('tag/create', {
      method: 'POST',
      body: { Tag: { Name: name } },
    });
    const tag = created.CreateResult?.Object;
    if (!tag) throw new Error(`Failed to create Rally tag: ${name}`);
    return tag._ref ?? `${this.apiBase}/tag/${tag.ObjectID}`;
  }

  async manageTags(
    formattedId: string,
    tags: string[],
    mode: 'add' | 'remove',
  ): Promise<{ added: string[]; removed: string[]; skipped: string[] }> {
    const item = await this.getWorkItem(formattedId);
    const tagCollection = item.raw?.Tags as { _ref?: string } | undefined;
    const existing = await this.collection<RallyRef>(tagCollection?._ref);
    const existingByName = new Map(
      existing
        .filter((tag): tag is RallyRef & { Name: string; _ref: string } => Boolean(tag.Name && tag._ref))
        .map((tag) => [tag.Name, tag._ref]),
    );
    const requested = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
    const added: string[] = [];
    const removed: string[] = [];
    const skipped: string[] = [];
    const refs = new Map(existingByName);
    if (mode === 'add') {
      for (const tag of requested) {
        if (refs.has(tag)) { skipped.push(tag); continue; }
        refs.set(tag, await this.resolveTagRef(tag));
        added.push(tag);
      }
    } else {
      for (const tag of requested) {
        if (!refs.delete(tag)) skipped.push(tag);
        else removed.push(tag);
      }
    }
    if (added.length || removed.length) {
      await this.updateWorkItem(formattedId, {
        Tags: [...refs.values()].map((ref) => ({ _ref: ref })),
      });
    }
    return { added, removed, skipped };
  }

  async attachFiles(
    formattedId: string,
    paths: string[],
    embedImages = false,
  ): Promise<{ attachments: Array<{ name: string; objectId: number }> }> {
    const item = await this.getWorkItem(formattedId);
    const attachments: Array<{ name: string; objectId: number }> = [];
    for (const path of paths) {
      const bytes = readFileSync(path);
      const content = await this.request<OperationResult<RallyRef>>('attachmentcontent/create', {
        method: 'POST',
        body: { AttachmentContent: { Content: bytes.toString('base64') } },
      });
      const contentObject = content.CreateResult?.Object;
      if (!contentObject?.ObjectID) throw new Error(`Failed to upload attachment content for ${path}.`);
      const contentRef = contentObject._ref ?? `${this.apiBase}/attachmentcontent/${contentObject.ObjectID}`;
      const name = basename(path);
      const attachment = await this.request<OperationResult<RallyRef>>('attachment/create', {
        method: 'POST',
        body: {
          Attachment: {
            Artifact: { _ref: item.ref },
            Content: { _ref: contentRef },
            Name: name,
            ContentType: contentType(path),
            Size: bytes.length,
          },
        },
      });
      const objectId = Number(attachment.CreateResult?.Object?.ObjectID ?? 0);
      if (!objectId) throw new Error(`Failed to create Rally attachment ${name}.`);
      attachments.push({ name, objectId });
    }
    if (embedImages) {
      const images = attachments.filter((attachment) => isImage(attachment.name));
      if (images.length) {
        let description = item.description ?? '';
        description += '<br/><br/><b>Attachments</b><br/>';
        for (const image of images) {
          const name = htmlEscape(image.name);
          description += `<div><b>${name}</b><br/><img src="/slm/attachment/${image.objectId}/${encodeURIComponent(image.name)}" alt="${name}" style="max-width:800px;" /></div><br/>`;
        }
        await this.updateWorkItem(formattedId, { Description: description }, true);
      }
    }
    return { attachments };
  }

  async queryPlanningItems(
    type: PlanningItemType,
    query = '(ObjectID > 0)',
    options: SearchWorkItemsOptions = {},
  ): Promise<PagedResult<PlanningItem>> {
    const workspace = await this.resolveWorkspaceRef(options.workspace ?? this.context.workspaceRef);
    const requestedProjects = options.projects?.length
      ? options.projects
      : options.project
        ? [options.project]
        : this.context.projectRef
          ? [this.context.projectRef]
          : [];
    const projects = requestedProjects.length
      ? await Promise.all([...new Set(requestedProjects)].map((value) => this.resolveProjectRef(value, workspace)))
      : [undefined];
    const page = positiveInteger(options.page, 1, 10_000);
    const pageSize = positiveInteger(options.pageSize, 50, 200);
    const order = normalizeOrder(options.order, type === 'iteration' ? 'StartDate DESC' : type === 'release' ? 'ReleaseStartDate DESC' : 'TargetDate DESC');
    const start = (page - 1) * pageSize + 1;
    const fields = type === 'iteration'
      ? 'ObjectID,Name,StartDate,EndDate,State,Project,Workspace,PlannedVelocity,LastUpdateDate,_ref'
      : type === 'release'
        ? 'ObjectID,Name,ReleaseStartDate,ReleaseDate,State,Project,Workspace,PlanEstimate,AcceptedLeafStoryPlanEstimate,LastUpdateDate,_ref'
        : 'ObjectID,Name,TargetDate,Status,Projects,TargetProject,DisplayColor,LastUpdateDate,_ref';
    const results = await Promise.all(projects.map((project) => this.request<QueryResult<Record<string, unknown>>>(type, {
      params: {
        query,
        fetch: fields,
        pagesize: pageSize,
        start,
        order,
        workspace,
        project,
        projectScopeUp: options.projectScopeUp ?? false,
        projectScopeDown: options.projectScopeDown ?? false,
      },
    })));
    const unique = new Map<string, PlanningItem>();
    let total = 0;
    const warnings: string[] = [];
    for (const response of results) {
      const result = response.QueryResult;
      total += result?.TotalResultCount ?? result?.Results?.length ?? 0;
      if (result?.Warnings?.length) warnings.push(...result.Warnings);
      for (const raw of result?.Results ?? []) {
        const objectId = Number(raw.ObjectID ?? 0);
        const ref = String(raw._ref ?? `${this.apiBase}/${type}/${objectId}`);
        unique.set(ref, {
          type,
          objectId,
          name: String(raw.Name ?? ''),
          ref,
          startDate: typeof raw.StartDate === 'string'
            ? raw.StartDate
            : typeof raw.ReleaseStartDate === 'string' ? raw.ReleaseStartDate : undefined,
          endDate: typeof raw.EndDate === 'string'
            ? raw.EndDate
            : typeof raw.ReleaseDate === 'string'
              ? raw.ReleaseDate
              : typeof raw.TargetDate === 'string' ? raw.TargetDate : undefined,
          state: typeof raw.State === 'string'
            ? raw.State
            : typeof raw.Status === 'string' ? raw.Status : undefined,
          project: raw.Project as RallyRef | undefined,
          workspace: raw.Workspace as RallyRef | undefined,
          raw,
        });
      }
    }
    const items = [...unique.values()].sort((a, b) => compareByOrder(a.raw, b.raw, order));
    return {
      items: items.slice(0, pageSize),
      page,
      pageSize,
      total: Math.max(total, items.length),
      hasMore: page * pageSize < total,
      order,
      warnings: [...new Set(warnings)],
    };
  }

  async queryCapacity(input: {
    iteration?: string;
    project?: string;
    user?: string;
    page?: number;
    pageSize?: number;
    order?: string;
  }): Promise<PagedResult<Record<string, unknown>> & { totalCapacity: number }> {
    const workspace = await this.resolveWorkspaceRef(this.context.workspaceRef);
    const project = await this.resolveProjectRef(input.project ?? this.context.projectRef, workspace);
    const clauses: string[] = [];
    if (input.iteration) {
      const iteration = await this.resolveEntityRef('iteration', input.iteration, workspace, project);
      clauses.push(`(Iteration = "${escapeQueryValue(iteration)}")`);
    }
    if (project) clauses.push(`(Project = "${escapeQueryValue(project)}")`);
    if (input.user) clauses.push(`(User = "${escapeQueryValue(await this.resolveOwnerRef(input.user))}")`);
    const query = clauses.length === 0
      ? '(ObjectID > 0)'
      : clauses.reduce((left, right) => left ? `(${left} AND ${right})` : right, '');
    const page = positiveInteger(input.page, 1, 10_000);
    const pageSize = positiveInteger(input.pageSize, 50, 200);
    const order = normalizeOrder(input.order, 'User ASC');
    const response = await this.request<QueryResult<Record<string, unknown>>>('useriterationcapacity', {
      params: {
        query,
        fetch: 'ObjectID,Capacity,User,Iteration,Project,LastUpdateDate,_ref',
        pagesize: pageSize,
        start: (page - 1) * pageSize + 1,
        order,
        workspace,
        project,
      },
    });
    const items = response.QueryResult?.Results ?? [];
    const total = response.QueryResult?.TotalResultCount ?? items.length;
    return {
      items,
      page,
      pageSize,
      total,
      hasMore: page * pageSize < total,
      order,
      warnings: response.QueryResult?.Warnings,
      totalCapacity: items.reduce((sum, value) => sum + Number(value.Capacity ?? 0), 0),
    };
  }

  private async resolveEntityRef(
    type: PlanningItemType,
    value: string,
    workspace?: string,
    project?: string,
  ): Promise<string> {
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`${type} cannot be empty.`);
    if (/^https?:\/\//i.test(trimmed) || trimmed.includes(`/${type}/`)) return trimmed;
    if (/^\d+$/.test(trimmed)) return `${this.apiBase}/${type}/${trimmed}`;
    const response = await this.request<QueryResult<RallyRef>>(type, {
      params: {
        query: `(Name = "${escapeQueryValue(trimmed)}")`,
        fetch: 'ObjectID,Name,_ref',
        pagesize: 2,
        workspace,
        project,
      },
    });
    const matches = response.QueryResult?.Results ?? [];
    if (!matches.length) throw new Error(`${type} not found: ${value}`);
    if (matches.length > 1) throw new Error(`Multiple ${type} records are named ${value}; use an ObjectID or ref.`);
    return matches[0]._ref ?? `${this.apiBase}/${type}/${matches[0].ObjectID}`;
  }

  private async getWorkItemByRef(ref: string): Promise<WorkItem> {
    const match = ref.match(/\/(hierarchicalrequirement|defect|portfolioitem\/feature|portfolioitem\/solutioncapability|task|testcase)\/(\d+)(?:\.json)?(?:\?.*)?$/i);
    if (!match) throw new Error(`Unsupported Rally work-item ref: ${ref}`);
    const path = match[1].toLowerCase();
    const entry = (Object.entries(WORK_ITEM_TYPES) as Array<[WorkItemType, (typeof WORK_ITEM_TYPES)[WorkItemType]]>)
      .find(([, details]) => details.path === path);
    if (!entry) throw new Error(`Unsupported Rally work-item ref: ${ref}`);
    const response = await this.request<Record<string, unknown>>(ref, { params: { fetch: DEFAULT_FETCH_FIELDS } });
    return this.toWorkItem(entry[0], unwrapRecord(response, [entry[0], entry[0].split('/').at(-1)!]));
  }

  async getRelationships(
    formattedId: string,
    options: PageOptions = {},
  ): Promise<Record<string, unknown>> {
    const item = await this.getWorkItem(formattedId);
    const raw = item.raw ?? {};
    const collectionFields = [
      'Children', 'UserStories', 'Predecessors', 'Successors', 'Tasks', 'Defects', 'TestCases',
    ];
    const collections = Object.fromEntries(await Promise.all(collectionFields.map(async (field) => [
      field,
      await this.collectionPage<Record<string, unknown>>(
        collectionRef(raw[field]),
        options,
        'ObjectID,FormattedID,Name,ScheduleState,State,Project,Owner,LastUpdateDate,_ref',
      ),
    ])));
    return {
      item,
      direct: {
        Parent: raw.Parent ?? null,
        WorkProduct: raw.WorkProduct ?? null,
        PortfolioItem: raw.PortfolioItem ?? null,
        Feature: raw.Feature ?? null,
        Iteration: raw.Iteration ?? null,
        Release: raw.Release ?? null,
      },
      collections,
    };
  }

  async getHierarchy(
    formattedId: string,
    options: { depth?: number; maxNodes?: number } = {},
  ): Promise<{ root: WorkItem; ancestors: WorkItem[]; descendants: Array<{ item: WorkItem; depth: number; parentRef: string }> }> {
    const root = await this.getWorkItem(formattedId);
    const depthLimit = positiveInteger(options.depth, 3, 8);
    const maxNodes = positiveInteger(options.maxNodes, 100, 500);
    const ancestors: WorkItem[] = [];
    const seen = new Set([root.ref]);
    let parentRef = collectionRef(root.raw?.Parent) ?? collectionRef(root.raw?.PortfolioItem);
    while (parentRef && ancestors.length < depthLimit && seen.size < maxNodes) {
      if (seen.has(parentRef)) break;
      const parent = await this.getWorkItemByRef(parentRef);
      seen.add(parent.ref);
      ancestors.push(parent);
      parentRef = collectionRef(parent.raw?.Parent) ?? collectionRef(parent.raw?.PortfolioItem);
    }
    const descendants: Array<{ item: WorkItem; depth: number; parentRef: string }> = [];
    const queue: Array<{ item: WorkItem; depth: number }> = [{ item: root, depth: 0 }];
    while (queue.length && seen.size < maxNodes) {
      const current = queue.shift()!;
      if (current.depth >= depthLimit) continue;
      const raw = current.item.raw ?? {};
      for (const field of ['Children', 'UserStories']) {
        const page = await this.collectionPage<Record<string, unknown>>(
          collectionRef(raw[field]),
          { pageSize: Math.min(200, maxNodes - seen.size) },
          DEFAULT_FETCH_FIELDS,
        );
        for (const childRaw of page.items) {
          const ref = String(childRaw._ref ?? '');
          if (!ref || seen.has(ref) || seen.size >= maxNodes) continue;
          const child = await this.getWorkItemByRef(ref);
          seen.add(ref);
          const depth = current.depth + 1;
          descendants.push({ item: child, depth, parentRef: current.item.ref });
          queue.push({ item: child, depth });
        }
      }
    }
    return { root, ancestors, descendants };
  }

  async manageDependencies(
    formattedId: string,
    direction: 'predecessors' | 'successors',
    targets: string[],
    mode: 'add' | 'remove',
    expectedLastUpdateDate?: string,
  ): Promise<WorkItem> {
    const item = await this.getWorkItem(formattedId);
    this.assertUnchanged(item, expectedLastUpdateDate, 'dependency update');
    const field = direction === 'predecessors' ? 'Predecessors' : 'Successors';
    const existing = await this.collection<RallyRef>(collectionRef(item.raw?.[field]));
    const refs = new Map(existing.filter((value) => value._ref).map((value) => [value._ref!, value]));
    for (const target of [...new Set(targets.map((value) => value.trim()).filter(Boolean))]) {
      const ref = target.includes('/') ? target : (await this.getWorkItem(target)).ref;
      if (ref === item.ref) throw new Error('A work item cannot depend on itself.');
      if (mode === 'add') refs.set(ref, { _ref: ref });
      else refs.delete(ref);
    }
    return this.updateWorkItem(formattedId, {
      [field]: [...refs.keys()].map((ref) => ({ _ref: ref })),
    }, false, expectedLastUpdateDate);
  }

  async moveWorkItem(
    formattedId: string,
    input: {
      project?: string | null;
      parent?: string | null;
      portfolioItem?: string | null;
      iteration?: string | null;
      release?: string | null;
      rankAbove?: string;
      rankBelow?: string;
      expectedLastUpdateDate?: string;
    },
  ): Promise<WorkItem> {
    const item = await this.getWorkItem(formattedId);
    this.assertUnchanged(item, input.expectedLastUpdateDate, 'move');
    if (input.rankAbove && input.rankBelow) throw new Error('Specify rankAbove or rankBelow, not both.');
    const workspace = await this.resolveWorkspaceRef(item.workspace?._ref ?? this.context.workspaceRef);
    const fields: Record<string, unknown> = {};
    let project = item.project?._ref;
    if (input.project !== undefined) {
      project = input.project === null ? undefined : await this.resolveProjectRef(input.project, workspace);
      fields.Project = project ? { _ref: project } : null;
    }
    if (input.parent !== undefined) {
      const parent = input.parent === null
        ? null
        : { _ref: input.parent.includes('/') ? input.parent : (await this.getWorkItem(input.parent)).ref };
      fields[item.type === 'Task' ? 'WorkProduct' : 'Parent'] = parent;
    }
    if (input.portfolioItem !== undefined) {
      fields.PortfolioItem = input.portfolioItem === null
        ? null
        : { _ref: input.portfolioItem.includes('/') ? input.portfolioItem : (await this.getWorkItem(input.portfolioItem)).ref };
    }
    if (input.iteration !== undefined) {
      fields.Iteration = input.iteration === null
        ? null
        : { _ref: await this.resolveEntityRef('iteration', input.iteration, workspace, project) };
    }
    if (input.release !== undefined) {
      fields.Release = input.release === null
        ? null
        : { _ref: await this.resolveEntityRef('release', input.release, workspace, project) };
    }
    const params: Record<string, string> = {};
    if (input.rankAbove) params.rankAbove = input.rankAbove.includes('/')
      ? input.rankAbove
      : (await this.getWorkItem(input.rankAbove)).ref;
    if (input.rankBelow) params.rankBelow = input.rankBelow.includes('/')
      ? input.rankBelow
      : (await this.getWorkItem(input.rankBelow)).ref;
    if (!Object.keys(fields).length && !Object.keys(params).length) throw new Error('Provide a destination relationship, project, iteration, release, or rank target.');
    return this.updateWorkItem(
      formattedId,
      fields,
      false,
      input.expectedLastUpdateDate,
      params,
    );
  }

  async mutatePlanningItem(input: {
    operation: 'create' | 'update';
    type: PlanningItemType;
    id?: number | string;
    fields: Record<string, unknown>;
    expectedLastUpdateDate?: string;
  }): Promise<Record<string, unknown>> {
    const wrapper = input.type[0].toUpperCase() + input.type.slice(1);
    if (input.operation === 'create') {
      return this.request(`${input.type}/create`, {
        method: 'POST',
        body: { [wrapper]: input.fields },
      });
    }
    if (input.id === undefined || input.id === '') throw new Error('Planning item update requires an ObjectID.');
    if (input.expectedLastUpdateDate) {
      const currentPayload = await this.request<Record<string, unknown>>(`${input.type}/${input.id}`, {
        params: { fetch: 'ObjectID,LastUpdateDate' },
      });
      const current = unwrapRecord(currentPayload, [wrapper]);
      const actual = typeof current.LastUpdateDate === 'string' ? current.LastUpdateDate : undefined;
      if (!actual || Date.parse(actual) !== Date.parse(input.expectedLastUpdateDate)) {
        throw new RallyConflictError(`${wrapper} ${input.id} changed in Rally after it was read.`, {
          formattedId: `${wrapper}:${input.id}`,
          operation: 'planning item update',
          expectedLastUpdateDate: input.expectedLastUpdateDate,
          actualLastUpdateDate: actual,
        });
      }
    }
    return this.request(`${input.type}/${input.id}`, {
      method: 'POST',
      body: { [wrapper]: input.fields },
    });
  }

  async mutateCapacity(input: {
    operation: 'create' | 'update';
    id?: number | string;
    fields: Record<string, unknown>;
    expectedLastUpdateDate?: string;
  }): Promise<Record<string, unknown>> {
    const path = 'useriterationcapacity';
    const wrapper = 'UserIterationCapacity';
    if (input.operation === 'create') {
      return this.request(`${path}/create`, {
        method: 'POST',
        body: { [wrapper]: input.fields },
      });
    }
    if (input.id === undefined || input.id === '') throw new Error('Capacity update requires an ObjectID.');
    if (input.expectedLastUpdateDate) {
      const payload = await this.request<Record<string, unknown>>(`${path}/${input.id}`, {
        params: { fetch: 'ObjectID,LastUpdateDate' },
      });
      const current = unwrapRecord(payload, [wrapper]);
      const actual = typeof current.LastUpdateDate === 'string' ? current.LastUpdateDate : undefined;
      if (!actual || Date.parse(actual) !== Date.parse(input.expectedLastUpdateDate)) {
        throw new RallyConflictError(`Capacity ${input.id} changed in Rally after it was read.`, {
          formattedId: `Capacity:${input.id}`,
          operation: 'capacity update',
          expectedLastUpdateDate: input.expectedLastUpdateDate,
          actualLastUpdateDate: actual,
        });
      }
    }
    return this.request(`${path}/${input.id}`, {
      method: 'POST',
      body: { [wrapper]: input.fields },
    });
  }

  async updateState(
    formattedId: string,
    input: { scheduleState?: string; defectState?: string },
  ): Promise<WorkItem> {
    const item = await this.getWorkItem(formattedId);
    if (input.defectState && item.type !== 'Defect') {
      throw new Error(`${formattedId} is not a Defect.`);
    }
    const fields: Record<string, unknown> = {};
    if (input.scheduleState) fields.ScheduleState = input.scheduleState;
    if (input.defectState) fields.State = input.defectState;
    if (!Object.keys(fields).length) throw new Error('Provide scheduleState or defectState.');
    return this.updateWorkItem(formattedId, fields);
  }

  async genericEntityOperation(input: {
    operation: 'query' | 'get' | 'create' | 'update' | 'delete';
    type: string;
    id?: string | number;
    query?: string;
    fetch?: string;
    limit?: number;
    data?: Record<string, unknown>;
  }): Promise<unknown> {
    const type = input.type.trim().replace(/^\/+|\/+$/g, '');
    const known = (() => {
      try { return resolveWorkItemType(type); } catch { return null; }
    })();
    const path = known ? WORK_ITEM_TYPES[known].path : type.toLowerCase().replace(/\s+/g, '');
    const wrapper = known ?? type;
    if (input.operation === 'query') {
      return this.request(path, {
        params: {
          query: input.query,
          fetch: input.fetch,
          pagesize: Math.max(1, Math.min(input.limit ?? 20, 2000)),
          workspace: this.context.workspaceRef,
          project: this.context.projectRef,
        },
      });
    }
    if (input.operation === 'create') {
      if (!input.data) throw new Error('Create requires data.');
      return this.request(`${path}/create`, {
        method: 'POST',
        body: Object.keys(input.data).some((key) => key.toLowerCase() === wrapper.toLowerCase())
          ? input.data
          : { [wrapper]: input.data },
      });
    }
    if (input.id === undefined || input.id === '') throw new Error(`${input.operation} requires an id.`);
    if (input.operation === 'get') {
      return this.request(`${path}/${encodeURIComponent(String(input.id))}`, {
        params: { fetch: input.fetch },
      });
    }
    if (input.operation === 'delete') {
      return this.request(`${path}/${encodeURIComponent(String(input.id))}`, { method: 'DELETE' });
    }
    if (!input.data) throw new Error('Update requires data.');
    return this.request(`${path}/${encodeURIComponent(String(input.id))}`, {
      method: 'POST',
      body: Object.keys(input.data).some((key) => key.toLowerCase() === wrapper.toLowerCase())
        ? input.data
        : { [wrapper]: input.data },
    });
  }
}
