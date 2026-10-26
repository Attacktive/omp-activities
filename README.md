# omp-activities

An unofficial [OMP](https://oh-my-pi.dev) plugin for compact tool history and live activity without extra AI calls.

> [!NOTE]
> Not built by the OMP team, and not affiliated with them in any way.

## Requirements

- OMP host version `18.12.6` or later (`@oh-my-pi/pi-coding-agent` and `@oh-my-pi/pi-tui`).

## Install

From a local checkout:

```bash
omp plugin link /path/to/omp-activities
```

This creates a symlink so edits take effect on the next launch.

From GitHub:

```bash
omp plugin install github:Attacktive/omp-activities
```

From npm:

```bash
omp plugin install omp-activities
```

All three methods install into `~/.omp/plugins/node_modules/omp-activities` and are recorded in `~/.omp/plugins/omp-plugins.lock.json`.
Manage installed plugins using the OMP CLI:

```bash
omp plugin list
omp plugin doctor
omp plugin uninstall omp-activities
```

### Migrating from local configuration extensions

If you previously loaded this extension from a local configuration directory (such as `agent/extensions/activity`), disable or remove that copy before installing the plugin.
You can add `extension-module:activity` to `disabledExtensions` in your OMP configuration or remove the directory to avoid registering duplicate commands and widgets.

## Controls

### History viewer

- `/activities` or **Ctrl+Alt+A** opens history focused on the newest call.
- Calls remain in chronological order with a compact tool/target row, outcome, and elapsed time when width permits.
- Tool identity takes priority over secondary exit outcomes and elapsed time in narrow rows, with full exit outcomes available in expanded details.
- **Up/Down** and **Page Up/Page Down** move selection between calls.
- **Home** or **g** jumps to the first call; **End** or **G** jumps to the last call.
- **Enter** expands full arguments, structured exit codes, and output or metadata directly beneath the selected call, retaining neighboring calls when space permits.
- The same navigation keys (**Up/Down**, **Page Up/Page Down**, **Home/g**, **End/G**) scroll wrapped content while a call is expanded.
- **Enter**, **q**, or **Escape** collapses the expanded call; **q** or **Escape** closes the viewer when calls are collapsed.
- **Ctrl+C** backs out without canceling active foreground tools.

### Search

- **/** searches forward and **?** searches backward.
- Input accepts a case-sensitive JavaScript regular expression and submits on **Enter**.
- **n** repeats the search in the current direction; **N** repeats the search in the reverse direction.
- An empty search repeats the previous pattern in the specified direction.
- Searches stop at boundaries without wrapping around.
- In the list view, search moves between matching rows by tool name, target, and status without hiding non-matching rows.
- Long targets scroll horizontally when selected to reveal matches beyond normal line truncation.
- Within an expanded call, search scans and highlights wrapped argument and output lines.
- Search input uses standard single-line editing controls; **q** remains literal text while typing a pattern.
- **Escape** or **Ctrl+C** cancels search input without leaving the viewer.

### Clearing history

- **/clear** clears tool history alongside the conversation context.
- Calls before the latest clear boundary remain hidden when history is reopened or a session is resumed.

### Live activity widget

- A themed Activity heading and tree-style rows display up to three active activities and an overflow counter.
- Ordinary calls show right-aligned elapsed runtime, with long targets truncated before runtime metadata.
- A dim `/activities` hint appears in the heading when space permits and is omitted in narrow terminals.
- Task calls display reported subagent names, active tool names and targets (or current intent when no target is available), and states.
- Active subagents take precedence over completed siblings.
- Terminal states remain visible until the parent task settles.
- The widget operates independently of OMP's tool-card visibility settings.

## Data, cost, and privacy

- No model calls, network requests, tool overrides, or injected conversation messages are performed.
- Call arguments and results come directly from host execution events and the active session branch.
- Call timing and status records are stored in custom session entries under `dev.attacktive.activity.timing` (`TIMING_ENTRY`).
- Custom timing entries are preserved across session branch navigation and restarts without being sent to the model.
- Unfinished calls from a previous process are marked as interrupted unless the host reports an active background job.
- Native terminal interrupts are classified as canceled only after an aborted turn confirms the interrupt.
- Headless or remote aborts without structured cancellation markers may be classified as failed.
- Output is terminal-sanitized but not secret-redacted beyond host behavior.
- Clearing history via `/clear` marks an application reset boundary and does not perform secure deletion of the underlying session journal.

## Known limitations

- History follows the active session branch and is not an independent cross-session database.
- Individual child-agent tools are not archived across restarts.
- Full details reflect content and metadata available from OMP, subject to existing host truncation and artifact retention.
- Binary image payloads are summarized rather than decoded.
- Requires OMP host version `18.12.6` or later.

## Publishing and release

The package is configured for public distribution on npm as `omp-activities` under the `MIT` license.
Package public access is configured via `publishConfig.access` set to `'public'` in `package.json`.

### Trusted publishing setup

Automated releases use [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) via OpenID Connect (OIDC) through GitHub Actions (`.github/workflows/publish.yaml`), requiring no long-lived npm tokens.
For a new package name, first publish the reviewed package from an authenticated maintainer account using `npm publish --access public`, completing npm's required authentication.
Do not push the matching release tag afterward: that would attempt to publish the same immutable version again.
Configure trusted publishing for subsequent versions before pushing their release tags:

1. Navigate to the package's settings on npmjs.com and select the **Trusted Publisher** section.
2. Choose **GitHub Actions** as the publisher.
3. Configure the publisher fields:
   - **Organization or user**: `Attacktive`
   - **Repository**: `omp-activities`
   - **Workflow filename**: `publish.yaml`
   - **Allowed actions**: Select direct publishing with `npm publish`.
4. Note that a newly created trusted publisher configuration must complete its initial publish within 2 days to bind to the repository identity.

> [!NOTE]
> Creating the workflow does not configure npm permissions or publish a package.

### Release workflow

1. Ensure the version in `package.json` reflects the desired release version (following Semantic Versioning).
2. Create and push a matching Git tag (for example, `0.1.0`).
3. The `.github/workflows/publish.yaml` workflow validates that the tag matches `package.json#version`, runs test, lint, and typecheck suites on Bun, installs latest npm on Node 24, mints an OIDC token (`id-token: write`), publishes to npm with automated provenance attestations, and cuts a GitHub release.

## Development

```bash
bun install
bun test
bun run typecheck
bun run lint
```

There is no build step; OMP loads TypeScript source directly.
