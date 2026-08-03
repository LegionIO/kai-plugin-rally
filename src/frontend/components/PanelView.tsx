import React, { useMemo, useState } from 'react';
import type { PluginComponentProps, WorkItem } from '../../shared/types.js';

function plainText(html?: string): string {
  if (!html) return '';
  try {
    return new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
  } catch {
    return html.replace(/<[^>]+>/g, ' ');
  }
}

function StatePill({ item }: { item: WorkItem }) {
  const state = item.scheduleState ?? item.state;
  if (!state) return null;
  return (
    <span className="rounded-full border border-border/70 bg-muted/60 px-2 py-0.5 text-[10px] text-muted-foreground">
      {state}
    </span>
  );
}

export function PanelView({ pluginState, onAction }: PluginComponentProps) {
  const state = pluginState;
  const [search, setSearch] = useState('');
  const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const [order, setOrder] = useState('LastUpdateDate DESC');
  const [scopeUp, setScopeUp] = useState(false);
  const [scopeDown, setScopeDown] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const authenticated = state?.auth.authenticated ?? false;
  const configured = state?.credentials.configured ?? false;
  const loading = state?.loading ?? {};
  const results = state?.results ?? [];
  const selected = state?.selectedItem ?? null;
  const details = state?.selectedDetails;
  const workspaces = state?.workspaces ?? [];
  const projects = state?.projects ?? [];
  const searchPage = state?.searchPage ?? { page: 1, pageSize: 50, total: 0, hasMore: false, order };
  const sync = state?.sync;

  const selectedDescription = useMemo(
    () => plainText(selected?.description || selected?.notes),
    [selected],
  );

  const invoke = async (action: string, data?: unknown) => {
    setLocalError(null);
    try {
      return await Promise.resolve(onAction(action, data));
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
      return null;
    }
  };

  const openSettings = () => {
    window.dispatchEvent(new CustomEvent('kai:open-settings', { detail: { plugin: 'rally' } }));
  };

  const runSearch = (page = 1) => invoke('search', {
    search,
    projects: selectedProjects,
    page,
    pageSize: searchPage.pageSize,
    order,
    projectScopeUp: scopeUp,
    projectScopeDown: scopeDown,
  });

  if (!configured) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-lg rounded-2xl border border-border/60 bg-card/70 p-6 text-center shadow-sm">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-xl">R</div>
          <h2 className="text-base font-semibold">Connect Rally</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Add a Rally OAuth client in plugin settings. Kai encrypts the Client ID, secret, and access token with OS safeStorage.
          </p>
          <button
            type="button"
            onClick={openSettings}
            className="mt-5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Open Rally settings
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Rally work items</h2>
          <p className="text-xs text-muted-foreground">
            Search by FormattedID, title text, or a WSAPI query.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${authenticated ? 'bg-emerald-500' : 'bg-amber-500'}`} />
          <span className="text-xs text-muted-foreground">
              {authenticated ? 'Connected' : 'Authorization required'}
          </span>
          {authenticated ? (
            <>
              <button
                type="button"
                onClick={() => void invoke('sync-now')}
                disabled={sync?.running}
                className="rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
                title={sync?.lastCompletedAt ? `Last synced ${new Date(sync.lastCompletedAt).toLocaleString()}` : 'Run saved Rally watches'}
              >
                {sync?.running ? 'Syncing…' : 'Sync now'}
              </button>
              <button
                type="button"
                onClick={() => void invoke('refresh-context')}
                disabled={loading.context}
                className="rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
              >
                {loading.context ? 'Refreshing…' : 'Refresh'}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => void invoke('login')}
              disabled={loading.auth}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {loading.auth ? 'Authorizing…' : 'Authorize'}
            </button>
          )}
          <button type="button" onClick={openSettings} className="rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-muted">
            Settings
          </button>
        </div>
      </header>

      {(localError || state?.error) && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {localError || state?.error}
        </div>
      )}

      <section className="grid gap-3 rounded-xl border border-border/60 bg-card/50 p-3 md:grid-cols-2 xl:grid-cols-4">
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Workspace</span>
          <select
            value={state?.context.workspaceRef ?? ''}
            disabled={!authenticated || loading.context}
            onChange={(event) => void invoke('select-workspace', { ref: event.target.value })}
            className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="">All available workspaces</option>
            {workspaces.map((workspace) => (
              <option key={workspace.ref} value={workspace.ref}>{workspace.name}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Project</span>
          <select
            value={state?.context.projectRef ?? ''}
            disabled={!authenticated || !state?.context.workspaceRef || loading.context}
            onChange={(event) => void invoke('select-project', { ref: event.target.value })}
            className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="">All projects</option>
            {projects.map((project) => (
              <option key={project.ref} value={project.ref}>
                {project.parentName ? `${project.parentName} / ` : ''}{project.name}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Search projects (⌘/Ctrl-click for multiple)</span>
          <select
            multiple
            value={selectedProjects}
            disabled={!authenticated || !state?.context.workspaceRef || loading.context}
            onChange={(event) => setSelectedProjects(Array.from(event.target.selectedOptions, (option) => option.value))}
            className="h-[68px] w-full rounded-lg border border-border bg-background px-2.5 py-2 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
          >
            {projects.map((project) => (
              <option key={project.ref} value={project.ref}>
                {project.parentName ? `${project.parentName} / ` : ''}{project.name}
              </option>
            ))}
          </select>
        </label>
        <div className="space-y-2 text-xs text-muted-foreground">
          <label className="block space-y-1">
            <span>Order</span>
            <select
              value={order}
              onChange={(event) => setOrder(event.target.value)}
              className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-xs text-foreground"
            >
              <option value="LastUpdateDate DESC">Recently updated</option>
              <option value="CreationDate DESC">Recently created</option>
              <option value="DragAndDropRank ASC">Rank</option>
              <option value="FormattedID ASC">Formatted ID</option>
              <option value="Name ASC">Name</option>
            </select>
          </label>
          <div className="flex gap-4">
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={scopeUp} onChange={(event) => setScopeUp(event.target.checked)} /> Scope up</label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={scopeDown} onChange={(event) => setScopeDown(event.target.checked)} /> Scope down</label>
          </div>
        </div>
      </section>

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch(1);
        }}
      >
        <input
          type="text"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          disabled={!authenticated}
          placeholder='US12345, dashboard, or (ScheduleState = "In-Progress")'
          className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2.5 text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!authenticated || !search.trim() || loading.search}
          className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {loading.search ? 'Searching…' : 'Search'}
        </button>
      </form>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(280px,0.9fr)_minmax(360px,1.4fr)]">
        <section className="min-h-0 overflow-y-auto rounded-xl border border-border/60 bg-card/40">
          <div className="sticky top-0 z-10 border-b border-border/60 bg-card/95 px-3 py-2 text-xs font-medium backdrop-blur">
            Results {searchPage.total ? `(${results.length} of ${searchPage.total})` : ''}
          </div>
          {results.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              {authenticated ? 'Search Rally to see work items.' : 'Authorize Kai to search Rally.'}
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {results.map((item) => (
                <button
                  type="button"
                  key={`${item.type}:${item.objectId}`}
                  onClick={() => void invoke('select-item', { formattedId: item.formattedId })}
                  className={`w-full px-3 py-3 text-left transition-colors hover:bg-muted/60 ${selected?.formattedId === item.formattedId ? 'bg-primary/8' : ''}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-primary">{item.formattedId}</span>
                    <StatePill item={item} />
                  </div>
                  <div className="mt-1 line-clamp-2 text-sm font-medium">{item.name}</div>
                  <div className="mt-1 text-[10px] text-muted-foreground">
                    {item.typeLabel}{item.project?._refObjectName ? ` · ${item.project._refObjectName}` : ''}
                  </div>
                </button>
              ))}
            </div>
          )}
          {(searchPage.page > 1 || searchPage.hasMore) && (
            <div className="sticky bottom-0 flex items-center justify-between border-t border-border/60 bg-card/95 px-3 py-2 text-xs backdrop-blur">
              <button
                type="button"
                disabled={searchPage.page <= 1 || loading.search}
                onClick={() => void runSearch(searchPage.page - 1)}
                className="rounded border border-border px-2 py-1 disabled:opacity-40"
              >Previous</button>
              <span className="text-muted-foreground">Page {searchPage.page}</span>
              <button
                type="button"
                disabled={!searchPage.hasMore || loading.search}
                onClick={() => void runSearch(searchPage.page + 1)}
                className="rounded border border-border px-2 py-1 disabled:opacity-40"
              >Next</button>
            </div>
          )}
        </section>

        <section className="min-h-0 overflow-y-auto rounded-xl border border-border/60 bg-card/40 p-4">
          {selected ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-primary">{selected.formattedId}</span>
                    <StatePill item={selected} />
                  </div>
                  <h3 className="mt-1 text-lg font-semibold leading-tight">{selected.name}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {selected.typeLabel}
                    {selected.project?._refObjectName ? ` · ${selected.project._refObjectName}` : ''}
                    {selected.owner?._refObjectName ? ` · ${selected.owner._refObjectName}` : ''}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void invoke('add-to-task-board', { formattedId: selected.formattedId })}
                    disabled={loading.taskBoard}
                    className="rounded-lg border border-border px-3 py-2 text-xs font-medium hover:bg-muted disabled:opacity-50"
                  >
                    {loading.taskBoard ? 'Adding…' : 'Add to Tasks'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void invoke('open-item', { url: selected.url })}
                    className="rounded-lg border border-border px-3 py-2 text-xs font-medium hover:bg-muted"
                  >
                    Open in Rally
                  </button>
                </div>
              </div>
              <div className="rounded-lg border border-border/50 bg-background/50 p-3">
                <h4 className="mb-2 text-xs font-semibold">Description</h4>
                <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                  {selectedDescription || 'No description.'}
                </p>
              </div>
              {details && (
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-lg border border-border/50 bg-background/50 p-3">
                    <h4 className="text-xs font-semibold">Discussions ({details.collections.discussions.total})</h4>
                    <div className="mt-2 space-y-2 text-xs text-muted-foreground">
                      {details.collections.discussions.items.slice(0, 5).map((post) => (
                        <div key={String(post.ObjectID)} className="rounded bg-muted/40 p-2">
                          <div className="whitespace-pre-wrap">{plainText(String(post.Text ?? ''))}</div>
                          {typeof post.CreationDate === 'string' && <div className="mt-1 text-[10px]">{new Date(post.CreationDate).toLocaleString()}</div>}
                        </div>
                      ))}
                      {!details.collections.discussions.items.length && <span>No discussion posts.</span>}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border/50 bg-background/50 p-3">
                    <h4 className="text-xs font-semibold">Attachments ({details.collections.attachments.total})</h4>
                    <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                      {details.collections.attachments.items.slice(0, 8).map((attachment) => (
                        <div key={String(attachment.ObjectID)} className="flex justify-between gap-2 rounded bg-muted/40 px-2 py-1.5">
                          <span className="truncate">{String(attachment.Name ?? `Attachment ${attachment.ObjectID}`)}</span>
                          <span>{typeof attachment.Size === 'number' ? `${Math.ceil(attachment.Size / 1024)} KB` : ''}</span>
                        </div>
                      ))}
                      {!details.collections.attachments.items.length && <span>No attachments.</span>}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border/50 bg-background/50 p-3">
                    <h4 className="text-xs font-semibold">Tags ({details.collections.tags.total})</h4>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {details.collections.tags.items.map((tag) => <span key={String(tag.ObjectID)} className="rounded-full bg-muted px-2 py-0.5 text-[10px]">{String(tag.Name ?? '')}</span>)}
                      {!details.collections.tags.items.length && <span className="text-xs text-muted-foreground">No tags.</span>}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border/50 bg-background/50 p-3">
                    <h4 className="text-xs font-semibold">Revision history ({details.collections.revisions.total})</h4>
                    <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                      {details.collections.revisions.items.slice(0, 5).map((revision) => (
                        <div key={String(revision.ObjectID)} className="truncate" title={String(revision.Description ?? '')}>
                          #{String(revision.RevisionNumber ?? '?')} · {plainText(String(revision.Description ?? 'Updated'))}
                        </div>
                      ))}
                      {!details.collections.revisions.items.length && <span>No revisions available.</span>}
                    </div>
                  </div>
                </div>
              )}
              <dl className="grid grid-cols-2 gap-3 text-xs">
                <div className="rounded-lg bg-muted/40 p-3">
                  <dt className="text-muted-foreground">Created</dt>
                  <dd className="mt-1 font-medium">{selected.creationDate ? new Date(selected.creationDate).toLocaleString() : '—'}</dd>
                </div>
                <div className="rounded-lg bg-muted/40 p-3">
                  <dt className="text-muted-foreground">Last updated</dt>
                  <dd className="mt-1 font-medium">{selected.lastUpdateDate ? new Date(selected.lastUpdateDate).toLocaleString() : '—'}</dd>
                </div>
                <div className="rounded-lg bg-muted/40 p-3">
                  <dt className="text-muted-foreground">Iteration / Release</dt>
                  <dd className="mt-1 font-medium">
                    {selected.iteration?._refObjectName || selected.release?._refObjectName || '—'}
                  </dd>
                </div>
                <div className="rounded-lg bg-muted/40 p-3">
                  <dt className="text-muted-foreground">Rank</dt>
                  <dd className="mt-1 truncate font-medium" title={selected.rank ? String(selected.rank) : undefined}>
                    {selected.rank ?? '—'}
                  </dd>
                </div>
              </dl>
            </div>
          ) : (
            <div className="flex h-full min-h-48 items-center justify-center text-center text-xs text-muted-foreground">
              Select a work item to view its details.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
