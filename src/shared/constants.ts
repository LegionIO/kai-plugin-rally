export const PLUGIN_NAME = 'rally';
export const PANEL_ID = 'work-items';
export const NAV_ID = 'rally-work-items';
export const SETTINGS_ID = 'rally-settings';

export const DEFAULT_BASE_URL = 'https://rally1.rallydev.com';
export const DEFAULT_LOGIN_URL = 'https://rally1.rallydev.com/';
export const REDIRECT_URI = 'http://127.0.0.1:8765/oauth/callback';
export const OAUTH_SCOPE = 'openid';
export const AUTH_PARTITION = 'persist:kai-rally';

export const SCHEDULE_STATES = ['Refining', 'Defined', 'In-Progress', 'Completed', 'Accepted'] as const;
export const DEFECT_STATES = ['Submitted', 'Open', 'Re-Test', 'Fixed', 'Re-Open', 'Closed'] as const;

export const DEFAULT_TOOL_PERMISSIONS = {
  read: true,
  write: false,
  delete: false,
  rawRequest: false,
} as const;

export const DEFAULT_SEARCH_ORDER = 'LastUpdateDate DESC';

export const DEFAULT_SYNC_SETTINGS = {
  enabled: false,
  intervalSeconds: 300,
  notifications: true,
  notifyOnNew: true,
  notifyOnUpdated: true,
  maxItemsPerWatch: 200,
  watches: [],
  taskBoard: {
    enabled: false,
    bidirectional: true,
    archiveMissing: true,
  },
} as const;

export const WORK_ITEM_TYPES = {
  HierarchicalRequirement: {
    label: 'User Story',
    path: 'hierarchicalrequirement',
    prefixes: ['US'],
  },
  Defect: {
    label: 'Defect',
    path: 'defect',
    prefixes: ['DE'],
  },
  'PortfolioItem/Feature': {
    label: 'Feature',
    path: 'portfolioitem/feature',
    prefixes: ['F'],
  },
  'PortfolioItem/SolutionCapability': {
    label: 'Solution Capability',
    path: 'portfolioitem/solutioncapability',
    prefixes: ['C'],
  },
  Task: {
    label: 'Task',
    path: 'task',
    prefixes: ['TA'],
  },
  TestCase: {
    label: 'Test Case',
    path: 'testcase',
    prefixes: ['TC'],
  },
} as const;

export const DEFAULT_FETCH_FIELDS = [
  'ObjectID',
  'FormattedID',
  'Name',
  'Description',
  'Notes',
  'ScheduleState',
  'State',
  'Project',
  'Workspace',
  'Owner',
  'Tags',
  'Attachments',
  'Discussion',
  'RevisionHistory',
  'Parent',
  'WorkProduct',
  'PortfolioItem',
  'Iteration',
  'Release',
  'Children',
  'UserStories',
  'Predecessors',
  'Successors',
  'Tasks',
  'Defects',
  'DragAndDropRank',
  'CreationDate',
  'LastUpdateDate',
  '_ref',
].join(',');
