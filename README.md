# Agent Change Guard

A VS Code / Cursor extension that tracks file changes made during an AI agent
session (Claude Code, Codex, Cursor Agent, or manual work), shows them in a
dedicated **Agent Changes** sidebar, and lets you diff, revert, or accept them.

It never touches git state. Baselines are plain file copies kept in the
extension's private storage, so reverting can't wipe your uncommitted work.

## Features

- **Agent Changes** activity-bar view listing every session.
- Tree of sessions → changed files with `Created` / `Modified` / `Deleted` badges.
- Built-in diff (baseline ↔ current) — click a file row.
- Revert a single file, revert a whole session, or accept and keep changes.
- File watching that ignores `node_modules`, `.git`, `.next`, `dist`, `build`,
  `out`, and `coverage`.

## Project structure

```
src/
  extension.ts        // activation, command wiring, diff + pickers
  sessionManager.ts   // session state, persistence, watcher, revert/accept
  snapshotManager.ts  // baseline file copies in private storage
  treeProvider.ts     // the Agent Changes tree view
  types.ts            // shared types
  utils.ts            // ids, paths, ignore rules
```

## Run it locally

```bash
npm install
npm run compile      # or: npm run watch  (rebuilds on save)
```

Then press **F5** in VS Code (or pick *Run Extension* in the Run & Debug panel).
This opens a second VS Code window — the **Extension Development Host** — with
the extension loaded.

> Open a real project folder in that host window before starting a session;
> the extension needs an open workspace folder to snapshot.

## Test it in the Extension Development Host

1. **Start a session** — open the **Agent Changes** view in the activity bar
   and click **＋** (or run `Agent Change Guard: Start Session` from the command
   palette). Enter a title such as *Fix login refresh issue*. The extension
   snapshots the workspace and begins watching.
2. **Make changes** — edit, create, or delete files (by hand or by letting an
   AI agent run). They appear under the session as you save.
3. **View changed files** — expand the session in the sidebar. Each file shows
   its status badge.
4. **Open a diff** — click a file row, or right-click → *Open Diff*. The left
   side is the baseline, the right side is the current file. Created files show
   an empty left side; deleted files show an empty right side.
5. **Revert a file** — right-click a file → *Revert File*, confirm. Modified
   files are restored, created files are deleted, deleted files are recreated.
6. **Revert a session** — right-click a session → *Revert Session* to restore
   every file; the session is marked `reverted`.
7. **Accept** — right-click a session → *Mark as Accepted* to keep the changes
   and discard the baseline snapshot.

All commands are also available from the command palette
(`Cmd/Ctrl+Shift+P` → "Agent Change Guard: …") with quick-pick fallbacks.

## How baselines work

On **Start Session** the extension copies the current workspace (minus ignored
folders and files over 5 MB) into private storage. That copy is the baseline
used for diffs and reverts. Because reverts only write from these copies, your
git index and other uncommitted changes are left untouched. Accepting a session
deletes its baseline; reverting keeps it until you accept or remove the session.
