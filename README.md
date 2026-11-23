# DevOps Connector

Import Azure DevOps work items into a VS Code workspace as Markdown files. Preview remote changes and choose when to sync your local copies.

## Status

Version 0.2.1 (phase 2) supports folder-specific connections and save directories, secure personal access token (PAT) storage, import and tracking, manual sync, read-only diffs, local edit protection, and recovery after an interrupted write. Open the tracked item list from the Command Palette. Scheduled checks, a dedicated sidebar, and general attachment downloads are outside the current release.

## Development and debugging

Use Node.js 22 or later, npm, and VS Code 1.95 or later.

~~~powershell
npm ci --ignore-scripts
npm test
npm run compile
~~~

Press **F5** in the extension project and select **Run DevOps Connector**. In the Extension Development Host, open a separate project folder for test exports. After changing the source, restart the debug session or run `npm run watch` and use **Developer: Reload Window** in the development host.

## Getting started

1. Press **Ctrl+Shift+P**, search for **Configuration**, and open the DevOps Connector configuration page. In a multi-root workspace, select the target folder.
2. Enter your organization URL (defaults to `https://vffice.visualstudio.com`), and choose **Save connection**. Leave **Project name** blank to import by ID across projects. The extension reads `System.TeamProject` and builds a source link for the item's actual project. To restrict imports to one project, enter its name or use its project URL. The default save directory is `.vscode/docs/workitems`.
3. Check the PAT source on the same page. Choose **Set or replace PAT** and enter a token with **Work Items (Read)** permission in the password prompt. VS Code SecretStorage keeps it per workspace folder and organization. Removing the saved PAT lets the extension use `AZURE_DEVOPS_PAT` if that environment variable has a value. Existing connections and credentials carry over. To manage a previous organization's PAT, switch back to that organization and save the connection.
4. Run **DevOps Connector: Import Work Item** and enter an ID or a full work item URL. A successful import confirms read access to that item.

### Creating an Azure DevOps PAT

1. Sign in to Azure DevOps, select **User settings** in the top-right corner, and open **Personal access tokens**.

   ![Open Personal access tokens from User settings](./docs/images/pat-user-settings.png)

2. Choose **New Token**, set a name, organization, and expiration, select **Custom defined** under **Scopes**, and check **Work Items -> Read**.

   ![Create a new personal access token with Work Items Read scope](./docs/images/pat-create-scopes.png)

3. Copy the generated token and enter it via **Set or replace PAT** in the extension configuration page. Alternatively, if you prefer using an environment variable instead of SecretStorage, set `AZURE_DEVOPS_PAT` in your user environment variables (and restart VS Code).

   ![Set AZURE_DEVOPS_PAT in Windows Environment Variables](./docs/images/pat-env-variable.png)

## Tracking and syncing existing exports

To start tracking a file exported by version 0.1.0, keep its original project configuration and save directory.

1. Run **Track Existing Work Item** and enter the original ID, for example `21835`.
2. The extension fetches the historical revision recorded in the file and reconstructs the export using its original format and timestamp. If the text matches, allowing for CRLF/LF differences, it creates a tracking record and keeps the original Markdown. If the file differs or the revision is unavailable, tracking stops. Back up local designs or notes and review the differences before retrying.
3. Run **Sync Work Item**, select the item, and review and confirm any update. An up-to-date local copy keeps its contents and timestamp.

Version 0.2.1 uses export template 3, which adds **Specifications** (`Custom.Specifications`) and **Design** (`Custom.Design`). For an already tracked file, run **Sync Work Item** directly. Even if the remote item is still at revision 73, an older template triggers an upgrade from version 1 or 2 to version 3. Confirm once to fill in the missing content. The extension retains the older renderers for historical verification and recovery. Template upgrades use the same local edit and concurrency checks as other updates.

| Command | What it does |
|---|---|
| Show Tracked Work Items | Lists items in the current save directory with their revision, last check, and status. Select an item to open or sync it. |
| Sync Work Item | Checks one item and asks before updating. You can preview the diff first. |
| Sync All Work Items | Updates eligible items after batch confirmation, skips conflicts and errors, and reports the results. |
| View Remote Changes | Opens a read-only diff between the local copy and the incoming document. |
| Compare with Last Synced Version | Compares the local file with its last successful sync baseline, including offline. |
| Translate Work Item to Chinese | Translates `workitem.md` into Simplified Chinese in chunks using the VS Code Language Model API (`vscode.lm`) and saves `workitem.zh-CN.md` alongside it without altering the sync baseline. |
| Stop Tracking Work Item | Removes the tracking record after confirmation and keeps the work item, designs, and notes. |

If you delete a tracked `workitem.md`, keep the adjacent `.devops-sync.json`. Run **Sync Work Item** and confirm to recreate the file, even when the remote revision is unchanged. If the file contains local changes or unsaved edits, sync reports a conflict. Use **Compare with Last Synced Version** to identify your changes, move notes to a separate file, restore and save the baseline text, then check again.

**Baseline established** means the extension has a verified local copy. **Update available** means it has found a change. Sync reports success after both the document and tracking record have been saved.

## Exported files

~~~text
your-project/
└── docs/workitems/
    └── 21835/
        ├── workitem.md       Managed Markdown copy
        ├── .devops-sync.json Source, full baseline, hash, and check status
        ├── images/           Images downloaded with the work item
        ├── design.md         Optional, user-maintained design
        └── notes.md          Optional, user-maintained notes
~~~

The export includes the title, ID, revision, template version, work item type, state, reason, assignee, area, iteration, tags, project, source link, change date, and export time. Metadata labels and section headings use English Azure DevOps terminology. The body contains Description, Specifications, Acceptance Criteria, Design, Repro Steps, and Comments. Custom specifications and design fields have their own sections. Empty sections have placeholders. Timestamps use ISO format in UTC.

Comments appear newest first by creation time. HTTPS images in fields and comments download to `images/` and use relative paths such as `images/example.png`. Markdown input retains its structure. HTML conversion supports common headings, lists, code, and simple tables. Complex rich text can look different from the Azure DevOps web view.

## Security and limitations

- The extension uses the read-only Azure DevOps Services API 7.1. Requests and exported links preserve the configured `dev.azure.com` or `visualstudio.com` hostname. Both URL forms for the same organization share a credential identity.
- The extension supports trusted, file-system workspaces and Azure DevOps Services. Self-hosted Azure DevOps Server, write-back, and web or virtual workspaces are unsupported. Remote development and enterprise proxy setups still require verification.
- Network activity occurs during user-initiated imports, tracking, checks, or syncs. The extension has no background polling or telemetry; the VS Code Language Model API (`vscode.lm`) is only invoked when you explicitly run **Translate Work Item to Chinese**.
- The extension sends the PAT only to validated Azure DevOps cloud URLs, rejects redirects, and keeps credentials and raw response bodies out of network errors.
- The save directory must be inside the workspace. Path validation rejects absolute paths, parent traversal, reserved names, symbolic links, and directory junctions.
- New files use exclusive hard-link creation. Updates use a temporary file in the same directory and an atomic replacement. Saving stops if the file system lacks the required capability.
- Before updating an existing file, sync rechecks its baseline hash and looks for unsaved edits. A per-item lock coordinates extension windows. External processes can still change files or replace directories between the final check and the write.
- A `.devops-sync.pending.json` journal allows recovery if a write stops between saving the document and its tracking state. Recovery checks the files and completes the state update when safe. Additional edits stop recovery. For a lock left after a crash, follow the recovery steps in `docs/manual-test.md`.
- Organization, project, and ID identify the source. Switching to an incompatible source prevents sync. Changing the save directory leaves earlier exports in place and limits tracking to the newly selected directory.
- Requests time out after 20 seconds. Work item responses are limited to 5 MB. Cancellation takes effect before file commit. Completed saves remain on disk.
- The Markdown file and the full baseline in `.devops-sync.json` can both contain internal information. Review them before committing. The extension leaves Git commits and pushes to the user.

## Verification and packaging

~~~powershell
npm run check
npm test
npm run compile
npm run package
~~~

The final command creates `work/devops-connector-0.2.1.vsix`. In the VS Code Extensions view, choose **Install from VSIX...** to install it locally. When testing via **F5**, stop the previous debug session before starting a new one.

The publisher is a local placeholder. Before distributing the extension, configure its repository and choose a distribution license. Local packaging skips the license check.

Unit tests use a mock API and run without a real PAT. Initial import has been confirmed with a real project. Use `docs/manual-test.md` for live checks of existing exports, manual sync, and the diff UI. After compiling, run `node scripts/smoke.mjs` with the path to an installed `Code.exe` to check startup in an isolated extension host. It uses a separate profile under `work/` and leaves real projects and credentials untouched.

See `docs/roadmap.md` for planned development.

## References

- [Work Items REST API 7.1](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/get-work-item?view=azure-devops-rest-7.1)
- [Get a historical work item revision](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/revisions/get?view=azure-devops-rest-7.1)
- [VS Code SecretStorage API](https://code.visualstudio.com/api/references/vscode-api#SecretStorage)
- [VS Code Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust)
