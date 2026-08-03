import type { WORK_ITEM_TYPES } from './constants.js';

export type WorkItemType = keyof typeof WORK_ITEM_TYPES;

export type OAuthCredentials = {
  clientId: string;
  clientSecret: string;
};

export type TokenRecord = {
  accessToken: string;
  baseUrl: string;
  createdAt: string;
  expiresAt?: string;
  scope?: string;
  tokenType?: string;
};

export type EncryptedRecord = {
  version: 1;
  ciphertext: string;
  hint?: string;
};

export type RallyContext = {
  workspaceRef?: string;
  workspaceName?: string;
  projectRef?: string;
  projectName?: string;
};

export type ProjectScope = {
  up: boolean;
  down: boolean;
};

export type PageOptions = {
  page?: number;
  pageSize?: number;
  order?: string;
};

export type PagedResult<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  order?: string;
  warnings?: string[];
};

export type SearchWorkItemsOptions = PageOptions & {
  workspace?: string;
  project?: string;
  projects?: string[];
  types?: string[];
  projectScopeUp?: boolean;
  projectScopeDown?: boolean;
};

export type PlanningItemType = 'iteration' | 'release' | 'milestone';

export type PlanningItem = {
  type: PlanningItemType;
  objectId: number;
  name: string;
  ref: string;
  startDate?: string;
  endDate?: string;
  state?: string;
  project?: RallyRef;
  workspace?: RallyRef;
  raw: Record<string, unknown>;
};

export type SyncWatch = {
  id: string;
  name: string;
  enabled: boolean;
  query: string;
  workspace?: string;
  projects?: string[];
  types?: string[];
  order?: string;
  projectScopeUp?: boolean;
  projectScopeDown?: boolean;
};

export type SyncSettings = {
  enabled: boolean;
  intervalSeconds: number;
  notifications: boolean;
  notifyOnNew: boolean;
  notifyOnUpdated: boolean;
  maxItemsPerWatch: number;
  watches: SyncWatch[];
  taskBoard: TaskBoardSyncSettings;
};

export type TaskBoardSyncSettings = {
  enabled: boolean;
  bidirectional: boolean;
  archiveMissing: boolean;
  /** Kai workspace captured when task-board mirroring is first enabled. */
  workspaceId?: string;
};

export type TaskBoardSyncResult = {
  created: number;
  updated: number;
  unchanged: number;
  unarchived: number;
  archived: number;
  pushed: number;
  failed: number;
};

export type SyncChange = {
  kind: 'new' | 'updated' | 'removed';
  watchId: string;
  watchName: string;
  formattedId: string;
  name?: string;
  previousLastUpdateDate?: string;
  lastUpdateDate?: string;
  url?: string;
};

export type SyncConflict = {
  formattedId: string;
  operation: string;
  expectedLastUpdateDate: string;
  actualLastUpdateDate?: string;
  detectedAt: string;
};

export type SyncStatus = {
  running: boolean;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  nextRunAt?: string;
  changes: SyncChange[];
  conflicts: SyncConflict[];
  taskBoard?: TaskBoardSyncResult;
  error?: string;
};

export type KaiTaskStatus = 'todo' | 'in_progress' | 'blocked' | 'ai_review' | 'human_review' | 'done';

export type KaiTaskExternalLink = {
  pluginName: string;
  source: string;
  externalId: string;
  externalKey?: string;
  url?: string;
  revision?: string;
  syncedAt: string;
};

export type KaiTask = {
  id: string;
  title: string;
  description: string;
  status: KaiTaskStatus;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  workspaceId?: string;
  priority?: number;
  metadata?: {
    category?: 'feature' | 'bug_fix' | 'refactoring' | 'docs' | 'other';
    labels?: string[];
    planFileName?: string;
    cwd?: string;
  };
  externalLinks?: KaiTaskExternalLink[];
  [key: string]: unknown;
};

export type KaiTaskInput = {
  title: string;
  description?: string;
  status?: KaiTaskStatus;
  metadata?: KaiTask['metadata'];
  workspaceId?: string;
  priority?: number;
};

export type KaiTaskChangeEvent = {
  type: 'created' | 'updated' | 'archived' | 'unarchived' | 'deleted';
  taskId: string;
  task?: KaiTask;
  previous?: KaiTask;
  changedFields: Array<keyof KaiTask>;
  origin:
    | { type: 'app' | 'system' }
    | { type: 'plugin'; pluginName: string; correlationId?: string };
  timestamp: string;
};

export type ToolPermissions = {
  read: boolean;
  write: boolean;
  delete: boolean;
  rawRequest: boolean;
};

export type RallyRef = {
  _ref?: string;
  _refObjectName?: string;
  ObjectID?: number;
  Name?: string;
};

export type WorkspaceOption = {
  name: string;
  objectId: number;
  ref: string;
};

export type ProjectOption = {
  name: string;
  objectId: number;
  ref: string;
  parentRef?: string;
  parentObjectId?: number;
  parentName?: string;
};

export type WorkItem = {
  type: WorkItemType;
  typeLabel: string;
  objectId: number;
  formattedId: string;
  name: string;
  description?: string;
  notes?: string;
  scheduleState?: string;
  state?: string;
  project?: RallyRef;
  workspace?: RallyRef;
  owner?: RallyRef & { UserName?: string };
  tags?: unknown;
  attachments?: unknown;
  discussion?: unknown;
  revisionHistory?: unknown;
  parent?: RallyRef;
  workProduct?: RallyRef;
  portfolioItem?: RallyRef;
  iteration?: RallyRef;
  release?: RallyRef;
  rank?: string | number;
  creationDate?: string;
  lastUpdateDate?: string;
  ref: string;
  url: string;
  raw?: Record<string, unknown>;
};

export type WorkItemDetails = {
  collections: {
    discussions: PagedResult<Record<string, unknown>>;
    attachments: PagedResult<Record<string, unknown>>;
    tags: PagedResult<Record<string, unknown>>;
    revisions: PagedResult<Record<string, unknown>>;
  };
  relationships: Record<string, unknown>;
};

export type CredentialState = {
  configured: boolean;
  clientIdHint?: string;
  encryptionAvailable: boolean;
  storage: 'safeStorage';
};

export type AuthState = {
  authenticated: boolean;
  verified: boolean;
  createdAt?: string;
  expiresAt?: string;
  scope?: string;
  error?: string;
};

export type RallyPluginState = {
  credentials: CredentialState;
  auth: AuthState;
  context: RallyContext;
  workspaces: WorkspaceOption[];
  projects: ProjectOption[];
  results: WorkItem[];
  selectedItem: WorkItem | null;
  selectedDetails: WorkItemDetails | null;
  searchPage: {
    page: number;
    pageSize: number;
    total: number;
    hasMore: boolean;
    order: string;
  };
  sync: SyncStatus;
  toolPermissions: ToolPermissions;
  loading: Record<string, boolean>;
  error: string | null;
};

export type PluginAuthResult = {
  success: boolean;
  params?: Record<string, string>;
  error?: string;
};

export type PluginAPI = {
  pluginName: string;
  pluginDir: string;
  config: {
    get: () => Record<string, unknown>;
    getPluginData: () => Record<string, unknown>;
    setPluginData: (path: string, value: unknown) => void;
    onChanged: (callback: (config: Record<string, unknown>) => void) => () => void;
  };
  state: {
    get: () => Record<string, unknown>;
    replace: (next: Record<string, unknown>) => void;
    set: (path: string, value: unknown) => void;
    emitEvent: (eventName: string, data?: unknown) => void;
  };
  tools: {
    register: (tools: unknown[]) => void;
    unregister: (toolNames: string[]) => void;
  };
  ui: {
    registerSettingsView: (descriptor: Record<string, unknown>) => void;
    registerPanelView: (descriptor: Record<string, unknown>) => void;
    registerNavigationItem: (descriptor: Record<string, unknown>) => void;
  };
  notifications: {
    show: (descriptor: Record<string, unknown>) => void;
    dismiss: (id: string) => void;
  };
  tasks: {
    list: (options?: { includeArchived?: boolean }) => Promise<KaiTask[]>;
    get: (taskId: string) => Promise<KaiTask | null>;
    create: (task: KaiTaskInput, options?: { correlationId?: string }) => Promise<KaiTask>;
    update: (
      taskId: string,
      updates: Partial<KaiTaskInput>,
      options?: { correlationId?: string },
    ) => Promise<KaiTask>;
    archive: (taskId: string, options?: { correlationId?: string }) => Promise<KaiTask>;
    unarchive: (taskId: string, options?: { correlationId?: string }) => Promise<KaiTask>;
    upsertExternal: (
      input: {
        external: Omit<KaiTaskExternalLink, 'pluginName' | 'syncedAt'>;
        task: KaiTaskInput;
        taskId?: string;
      },
      options?: { correlationId?: string },
    ) => Promise<{ task: KaiTask; created: boolean }>;
    onChanged: (handler: (event: KaiTaskChangeEvent) => void | Promise<void>) => () => void;
  };
  auth: {
    openAuthWindow: (options: Record<string, unknown>) => Promise<PluginAuthResult>;
  };
  safeStorage: {
    isEncryptionAvailable: () => boolean;
    encryptString: (plaintext: string) => string;
    decryptString: (base64Cipher: string) => string;
  };
  shell: {
    openExternal: (url: string) => Promise<void>;
  };
  log: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  onAction: (
    targetId: string,
    handler: (action: string, data?: unknown) => unknown | Promise<unknown>,
  ) => void;
  fetch: typeof globalThis.fetch;
};

export type PluginComponentProps = {
  pluginName: string;
  pluginState?: RallyPluginState;
  pluginConfig?: Record<string, unknown>;
  setPluginConfig?: (path: string, value: unknown) => Promise<void>;
  onAction: (action: string, data?: unknown) => unknown;
  onClose?: () => void;
  props?: Record<string, unknown>;
};
