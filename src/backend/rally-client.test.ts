import { describe, expect, it, vi } from 'vitest';
import type { PluginAPI, TokenRecord } from '../shared/types.js';
import { RallyClient } from './rally-client.js';

const token: TokenRecord = {
  accessToken: 'access-token',
  baseUrl: 'https://rally1.rallydev.com',
  createdAt: '2026-08-03T00:00:00.000Z',
};

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('RallyClient', () => {
  it('authenticates WSAPI calls with ZSESSIONID', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      response({ QueryResult: { Results: [] } })
    ));
    const client = new RallyClient({ fetch: fetchMock } as unknown as PluginAPI, token);

    await client.request('defect', { params: { pagesize: 1 } });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0];
    expect((init?.headers as Record<string, string>).ZSESSIONID).toBe('access-token');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/slm/webservice/v2.0/defect?pagesize=1');
  });

  it('treats Rally Errors arrays as failures even for HTTP 200', async () => {
    const api = {
      fetch: vi.fn(async () => response({ QueryResult: { Errors: ['Bad query'] } })),
    } as unknown as PluginAPI;
    const client = new RallyClient(api, token);

    await expect(client.request('defect')).rejects.toThrow('Bad query');
  });

  it('refuses to send the token to another origin', async () => {
    const api = { fetch: vi.fn() } as unknown as PluginAPI;
    const client = new RallyClient(api, token);

    await expect(client.request('https://example.com/steal')).rejects.toThrow('another origin');
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it('merges, orders, de-duplicates, and pages multi-project search results', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const project = url.searchParams.get('project');
      const common = {
        ObjectID: 2,
        FormattedID: 'DE2',
        Name: 'Shared',
        LastUpdateDate: '2026-08-02T00:00:00.000Z',
        _ref: 'https://rally1.rallydev.com/slm/webservice/v2.0/defect/2',
      };
      const Results = project?.endsWith('/1')
        ? [
          common,
          { ...common, ObjectID: 1, FormattedID: 'DE1', Name: 'Old', LastUpdateDate: '2026-08-01T00:00:00.000Z', _ref: 'https://rally1.rallydev.com/slm/webservice/v2.0/defect/1' },
        ]
        : [
          { ...common, ObjectID: 3, FormattedID: 'DE3', Name: 'New', LastUpdateDate: '2026-08-03T00:00:00.000Z', _ref: 'https://rally1.rallydev.com/slm/webservice/v2.0/defect/3' },
          common,
        ];
      return response({ QueryResult: { Results, TotalResultCount: 2 } });
    });
    const client = new RallyClient({ fetch: fetchMock } as unknown as PluginAPI, token);

    const result = await client.searchWorkItemsPage('(State = "Open")', {
      types: ['Defect'],
      projects: [
        'https://rally1.rallydev.com/slm/webservice/v2.0/project/1',
        'https://rally1.rallydev.com/slm/webservice/v2.0/project/2',
      ],
      page: 1,
      pageSize: 2,
      order: 'LastUpdateDate DESC',
      projectScopeDown: true,
    });

    expect(result.items.map((item) => item.formattedId)).toEqual(['DE3', 'DE2']);
    expect(result.total).toBe(4);
    expect(result.hasMore).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [input] of fetchMock.mock.calls) {
      const url = new URL(String(input));
      expect(url.searchParams.get('projectScopeDown')).toBe('true');
      expect(url.searchParams.get('order')).toBe('LastUpdateDate DESC');
    }
  });

  it('rejects stale optimistic updates before sending a mutation', async () => {
    const fetchMock = vi.fn(async () => response({
      QueryResult: {
        Results: [{
          ObjectID: 7,
          FormattedID: 'DE7',
          Name: 'Changed remotely',
          LastUpdateDate: '2026-08-03T12:00:00.000Z',
          _ref: 'https://rally1.rallydev.com/slm/webservice/v2.0/defect/7',
        }],
        TotalResultCount: 1,
      },
    }));
    const client = new RallyClient({ fetch: fetchMock } as unknown as PluginAPI, token);

    await expect(client.updateWorkItem(
      'DE7',
      { Name: 'Local edit' },
      false,
      '2026-08-03T11:00:00.000Z',
    )).rejects.toMatchObject({ name: 'RallyConflictError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
