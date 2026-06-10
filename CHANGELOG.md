# Changelog

All notable changes to the Agent Change Guard extension are documented here.

## [0.2.0] — 2026-06-10

Per-turn tracking.

### Added

- **Checkpoints**: sessions are now organised turn by turn. Each checkpoint
  records the files changed during that turn, with content stored as
  deduplicated blobs in private storage.
- **Claude Code integration**: while a session is active, the extension tails
  Claude Code's transcript files for the workspace and automatically creates
  a checkpoint per user message, labelled with the message. Controlled by
  `agentChangeGuard.claudeCode.autoCheckpoint` (on by default).
- Optional auto-start: `agentChangeGuard.claudeCode.autoStartSession` starts
  a session on the first Claude Code message when none is active (off by
  default).
- **Create Checkpoint** command for manual turn boundaries with any agent.
- **Restore To Checkpoint**: rewind the workspace to the end of any turn —
  files changed by later turns are restored, earlier work is kept, history
  is preserved.
- Per-turn diffs: click a file under a checkpoint to see that turn's
  before ↔ after.
- Explorer file decorations (✦ badge, git-style colors) on files changed
  during the active session.
- Status bar now also shows the turn count.

## [0.1.0] — 2026-06-10

First publishable release.

### Added

- Settings: `agentChangeGuard.ignoreDirectories`, `agentChangeGuard.respectGitignore`,
  and `agentChangeGuard.maxFileSizeMB`.
- The workspace root `.gitignore` is respected when tracking and snapshotting
  (can be turned off).
- Status bar item showing the active session and its change count; click to
  open the Agent Changes view.
- **Remove Session** command: deletes a session and its snapshot data
  (workspace files are untouched).
- Reconcile on startup: edits made while the window was closed are detected
  when an active session is resumed.
- Binary files are detected before opening a diff, with an "Open Anyway"
  escape hatch.

### Changed

- Change detection is now content-based: a file is only listed as *Modified*
  if its bytes actually differ from the baseline (no more false positives from
  formatters or no-op saves), and a file edited back to its original content
  drops off the list.
- Session persistence is debounced, so bulk agent edits no longer trigger a
  storage write per file event.
- The extension is bundled with esbuild for faster startup and a smaller
  package.

## [0.0.1]

- Initial MVP: manual sessions, workspace baseline snapshots, change tree,
  diff, per-file and per-session revert, accept.
