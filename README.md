# Kai Rally Plugin

Native Broadcom Rally integration for Kai Desktop:

- Rally OAuth authorization-code sign-in
- Client credentials and access token protected by Electron `safeStorage`
- Workspace/project selection and a searchable work-item panel
- Multi-project paging, ordering, de-duplication, and project scope-up/scope-down
- User Story, Defect, Feature, Solution Capability, Task, and Test Case support
- Expanded discussions, attachments, tags, revisions, hierarchy, and dependency reading
- Attachment download/delete and discussion create/update/delete
- Iterations, releases, milestones, user iteration capacity, and rank-above/rank-below
- Story/portfolio hierarchy, parents, children, predecessors, and successors
- Project/parent/portfolio/iteration/release move operations
- Background watch-query polling, change notifications, and conflict-safe writes
- Opt-in Rally watch mirroring and two-way synchronization with Kai Tasks/Kanban
- Markdown descriptions, owners, tags, file attachments, and inline images
- Schedule-state and Defect-state updates
- Opt-in generic WSAPI and guarded delete tools

## Build and install for development

Requirements: Node.js 22+ and npm.

```bash
npm install
npm run check
npm run build:dev
```

`npm run build:dev` writes the built plugin to `~/.kai/plugins/rally/`. Restart Kai Desktop or reload plugins after installing it.

Production artifacts are written to `dist/` by `npm run build`.

## Rally OAuth setup

1. Sign in to Rally in a normal browser. If your organization uses SSO, use its Rally login URL.
2. From your profile avatar, open **My Settings → Access → OAuth Clients**, then click **Create**. The plugin intentionally does not link directly to this page because Rally URLs can contain user- or context-specific IDs.
3. Name the client, for example `Kai Desktop`.
4. Set the callback URL exactly to:

   ```text
   http://127.0.0.1:8765/oauth/callback
   ```

5. Copy the Client ID and Secret Key into Kai's **Rally plugin settings**. The **Rally Login URL** defaults to `https://rally1.rallydev.com/`; replace it if your organization provides a different login URL.
6. Save the values, then click **Authorize Kai with Rally**.

Kai opens the Rally Login URL and Rally OAuth authorization in the same isolated, persistent authentication session. The Client ID and secret identify the Kai OAuth application; interactive sign-in may still be required to identify the Rally user and grant access. The callback is intercepted by Kai; the plugin does not open a local listening socket.

## Security model

- Client ID and secret are encrypted together with Electron `safeStorage` before plugin config is written.
- The OAuth access token is also encrypted with `safeStorage`.
- No client secret or token is included in source, `plugin.json`, build output, logs, state published to the renderer, or tool results.
- WSAPI uses `ZSESSIONID`; the token is never sent with Bearer authentication.
- Requests are restricted to the configured Rally origin.
- Any Rally `Errors` array is treated as a failure even when HTTP status is 200.
- Write tools are disabled by default and require `confirmed=true` after the user confirms the exact mutation.
- Raw WSAPI and deletion tools are separately disabled by default. Deletion always requires explicit confirmation.
- Sign-out revokes the remote token before deleting its encrypted local copy.

## AI tools

Read tools (enabled by default):

- `rally_auth_status`
- `rally_list_workspaces`
- `rally_list_projects`
- `rally_search_work_items`
- `rally_get_work_item`
- `rally_get_work_item_collections`
- `rally_get_relationships`
- `rally_get_hierarchy`
- `rally_query_planning`
- `rally_get_capacity`
- `rally_sync_status`
- `rally_sync_now`

Write tools (opt-in):

- `rally_create_work_item`
- `rally_update_work_item`
- `rally_add_discussion`
- `rally_update_discussion`
- `rally_manage_tags`
- `rally_attach_files`
- `rally_update_state`
- `rally_move_work_item`
- `rally_manage_dependencies`
- `rally_manage_planning_item`
- `rally_manage_capacity`
- `rally_download_attachment`
- `rally_import_to_task_board`
- `rally_manage_sync`

Advanced tools (separately opt-in):

- `rally_wsapi_request`
- `rally_delete_object`
- `rally_delete_attachment`
- `rally_delete_discussion`

## Background synchronization and conflicts

Saved watch queries poll while Kai Desktop is running. A first successful poll creates a baseline; later polls publish `work-item-changed` and `sync-completed` plugin events and can show notifications for new or updated items. Polling is disabled by default, has a 30-second minimum interval, does not overlap runs, and suppresses false removal events when a watch is truncated by its item limit.

Updates and move operations accept `expectedLastUpdateDate`. If Rally changed since the caller last read the item, the plugin rejects the write, publishes `sync-conflict`, records the conflict in plugin state, and asks the caller to refresh rather than overwriting remote work.

## Kai Tasks/Kanban synchronization

Kai Desktop v1.0.226 added the `tasks:read`, `tasks:write`, and `tasks:sync` plugin surface. Rally mirroring is separately opt-in under **Rally settings → Background synchronization**:

- Every item matched by an enabled Rally watch is upserted by stable Rally source, work-item type, and ObjectID. Multiple watches cannot create duplicate cards.
- Cards are placed in the Kai workspace that was active when mirroring was first enabled.
- Rally title, description, state, FormattedID, URL, and LastUpdateDate are represented on the card/external link.
- User Story, Defect, and Rally Task states map to Kai's Todo, In Progress, Review, and Done workflow. Kai's richer Blocked and AI Review states are preserved when Rally reports the same broader state family.
- With two-way sync enabled, local title, description, and compatible status edits are pushed to Rally using the linked LastUpdateDate as an optimistic conflict guard.
- Cards that no longer match any complete enabled watch can be archived automatically. Truncated watch results never cause archival.
- Manually archived or deleted external cards remain dismissed instead of being recreated on the next poll.
- A single work item can also be imported immediately from the Rally panel with **Add to Tasks** or through `rally_import_to_task_board`.

The manifest requires the `tasks:sync` host capability and asks for elevated `tasks:write` consent. Older Kai releases reject the plugin instead of loading it with a partial task API.

When attaching images, `embedImages` defaults to `true` so the images are visible in the work-item description, matching the upstream skill's critical image rule.

## Commands

```bash
npm run typecheck  # TypeScript validation
npm test           # Unit tests
npm run build      # Build dist/
npm run build:dev  # Build into ~/.kai/plugins/rally/
npm run dev        # Watch and build into the Kai plugin directory
npm run check      # Typecheck, tests, and production build
```
