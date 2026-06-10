# Agent Change Guard

Track, diff, and revert every file change made during an AI agent session —
turn by turn. Works with Claude Code out of the box, and with Codex, Cursor
Agent, or manual work via sessions and manual checkpoints, in VS Code or
Cursor.

**It never touches git.** Baselines and checkpoints are plain file copies kept
in the extension's private storage, so reverting can't wipe your uncommitted
work, your index, or your stash.

## Why

AI agents can touch dozens of files in one turn. Before you accept that work,
you want to see exactly what changed — per message, not just per session — and
be able to rewind to any point, without committing first and without trusting
the agent's own summary.

## Features

- **Per-turn checkpoints**: with Claude Code, every user message automatically
  becomes a checkpoint labelled with that message. Expand a turn to see
  exactly which files it touched and diff each one against its state before
  the turn.
- **Restore to checkpoint**: rewind the workspace to the end of any turn.
  Files changed by later turns are restored; earlier work is kept.
- **Agent Changes** activity-bar view: sessions → turns → files, with
  `Created` / `Modified` / `Deleted` badges.
- Built-in diffs: per-turn (before ↔ after the turn) and cumulative
  (baseline ↔ current).
- Revert a single file, revert a whole session, or accept and keep changes.
- Explorer badges (✦) on files changed during the active session.
- Status bar counter showing changes and turns while recording.
- Content-based detection: files only appear if their bytes actually changed;
  a file edited back to its original content drops off the list.
- Respects your `.gitignore` plus a configurable ignore list.
- Changes made while the window was closed are picked up on reload.

## Usage with Claude Code

1. Run `Agent Change Guard: Start Session` (or click **＋** in the Agent
   Changes view) before — or while — Claude Code works.
2. Chat with Claude Code as usual. Each message you send closes out the
   previous turn into a checkpoint named after that message.
3. Expand a turn in the sidebar to see its files; click one for the
   before ↔ after diff of that turn.
4. Right-click a turn → **Restore To Checkpoint** to rewind later work.

Set `agentChangeGuard.claudeCode.autoStartSession` to `true` to start a
session automatically on the first Claude Code message when none is active.

## Usage with other agents (or by hand)

Start a session, let the agent work, and run
`Agent Change Guard: Create Checkpoint` whenever you want to mark a boundary.
Without checkpoints, a session shows a flat list of cumulative changes —
diff, revert per file, revert the session, or accept.

All commands are in the command palette under `Agent Change Guard: …`.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `agentChangeGuard.ignoreDirectories` | `node_modules`, `.git`, `dist`, … | Directory names that are never tracked or snapshotted. |
| `agentChangeGuard.respectGitignore` | `true` | Also ignore files matched by the workspace root `.gitignore`. |
| `agentChangeGuard.maxFileSizeMB` | `5` | Files larger than this are not snapshotted and cannot be reverted. |
| `agentChangeGuard.claudeCode.autoCheckpoint` | `true` | Create a checkpoint per Claude Code turn while a session is active. |
| `agentChangeGuard.claudeCode.autoStartSession` | `false` | Auto-start a session on the first Claude Code message. |

## How it works

On **Start Session** the workspace (minus ignored paths and oversized files)
is copied into private extension storage as the baseline. While the session is
active, a file watcher records changes, comparing content hashes so no-op
saves don't count. At each turn boundary the changed files' contents are
stored as content-addressed blobs — that's what powers per-turn diffs and
restore. Claude Code turns are detected by tailing its transcript files under
`~/.claude/projects/`; nothing is sent anywhere, and your chats are only read
to extract message boundaries and labels.

Because reverts and restores only write from these private copies, your git
state and other uncommitted changes are left untouched. Accepting or removing
a session deletes its stored data.

## Limitations

- One session at a time; multi-root workspaces track only the first folder.
- Renames show as a delete plus a create.
- Files over the size limit are listed but cannot be diffed or restored.
- Cursor Agent and Codex turns are not auto-detected yet (use manual
  checkpoints); Claude Code detection relies on its transcript file format.

## Development

```bash
npm install
npm run compile      # bundle with esbuild (or: npm run watch)
npm run typecheck    # tsc --noEmit
```

Press **F5** in VS Code (*Run Extension*) to launch an Extension Development
Host with the extension loaded. Open a real project folder in that window
before starting a session.

```
src/
  extension.ts        // activation, command wiring, diffs, status bar
  sessionManager.ts   // session + checkpoint state, watcher, revert/restore
  snapshotManager.ts  // baseline copies + content-addressed checkpoint blobs
  claudeWatcher.ts    // tails Claude Code transcripts -> turn boundaries
  treeProvider.ts     // the Agent Changes tree view
  decorations.ts      // Explorer badges for agent-touched files
  types.ts            // shared types
  utils.ts            // ids, paths, ignore rules, hashing
```

Package a `.vsix` with `npm run package`.

## License

MIT
