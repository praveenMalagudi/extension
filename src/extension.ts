import * as vscode from "vscode";
import { ClaudeWatcher } from "./claudeWatcher";
import { CodexWatcher } from "./codexWatcher";
import { AgentDecorationProvider } from "./decorations";
import { FileState, SessionManager } from "./sessionManager";
import { SnapshotManager } from "./snapshotManager";
import { AgentTreeProvider, TreeNode } from "./treeProvider";
import { TurnFlowActions, TurnFlowPanel, TurnRef } from "./turnFlowPanel";
import { TurnTraces } from "./turnTrace";
import { AgentMessageSource, AgentSession } from "./types";
import { getWorkspaceFolder, isProbablyBinary, toAbsolutePath } from "./utils";

/** Virtual scheme used to show an empty side in a diff (created/deleted). */
const EMPTY_SCHEME = "agentguard-empty";

export function activate(context: vscode.ExtensionContext): void {
  const snapshots = new SnapshotManager(context);
  const sessions = new SessionManager(context, snapshots);
  const traces = new TurnTraces();
  const tree = new AgentTreeProvider(sessions, traces);
  const statusBar = createStatusBar(sessions);
  const flowActions: TurnFlowActions = {
    openDiff: (node, column) => openDiff(sessions, snapshots, node, column),
    openSource: (source) => openSourceMessage(source),
  };

  context.subscriptions.push(
    sessions,
    statusBar,
    new AgentDecorationProvider(sessions),
    new ClaudeWatcher(sessions),
    new CodexWatcher(sessions),
    vscode.window.registerTreeDataProvider("agentChangesView", tree),
    // Provides empty content for the "missing" side of created/deleted diffs.
    vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, {
      provideTextDocumentContent: () => "",
    }),
  );

  // A session may have been active when the window closed; pick up anything
  // that changed while we were not watching.
  if (sessions.getActiveSession()) {
    void sessions.reconcile();
  }

  const register = (
    command: string,
    handler: (...args: unknown[]) => unknown,
  ) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(command, handler),
    );

  register("agentChangeGuard.refresh", () => tree.refresh());

  register("agentChangeGuard.startSession", () =>
    startSession(sessions),
  );

  register("agentChangeGuard.endSession", (node?: unknown) =>
    sessions.endSession(asSession(node)?.id),
  );

  register("agentChangeGuard.createCheckpoint", () =>
    createCheckpoint(sessions),
  );

  register("agentChangeGuard.restoreCheckpoint", async (node?: unknown) =>
    restoreCheckpoint(sessions, asCheckpoint(node)),
  );

  register("agentChangeGuard.openSourceMessage", async (node?: unknown) =>
    openSourceMessage(sourceFromNode(node)),
  );

  register("agentChangeGuard.showTurnFlow", async (node?: unknown) => {
    const ref = turnRefFromNode(node) ?? (await pickTurn(sessions));
    if (ref) {
      TurnFlowPanel.show(context.extensionUri, sessions, traces, flowActions, ref);
    }
  });

  register("agentChangeGuard.openDiff", async (node?: unknown) =>
    openDiff(
      sessions,
      snapshots,
      asFileNode(node) ?? (await pickFile(sessions)),
    ),
  );

  register("agentChangeGuard.revertFile", async (node?: unknown) =>
    revertFile(sessions, asFileNode(node) ?? (await pickFile(sessions))),
  );

  register("agentChangeGuard.revertSession", async (node?: unknown) =>
    revertSession(sessions, asSession(node) ?? (await pickSession(sessions))),
  );

  register("agentChangeGuard.markAccepted", async (node?: unknown) =>
    markAccepted(sessions, asSession(node) ?? (await pickSession(sessions))),
  );

  register("agentChangeGuard.removeSession", async (node?: unknown) =>
    removeSession(sessions, asSession(node) ?? (await pickSession(sessions))),
  );
}

export function deactivate(): void {
  // Subscriptions handle cleanup.
}

// ---- Status bar ------------------------------------------------------------

function createStatusBar(sessions: SessionManager): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50,
  );
  item.command = "workbench.view.extension.agentChangeGuard";
  const update = () => {
    const active = sessions.getActiveSession();
    if (!active) {
      item.hide();
      return;
    }
    const count = active.changedFiles.length;
    const turns = active.checkpoints.length;
    item.text = `$(shield) ${count} change${count === 1 ? "" : "s"}${
      turns > 0 ? ` · ${turns} turn${turns === 1 ? "" : "s"}` : ""
    }`;
    item.tooltip = `Agent Change Guard — recording "${active.title}". Click to open.`;
    item.show();
  };
  sessions.onDidChange(update);
  update();
  return item;
}

// ---- Command implementations ---------------------------------------------

async function startSession(sessions: SessionManager): Promise<void> {
  if (!getWorkspaceFolder()) {
    vscode.window.showErrorMessage(
      "Agent Change Guard needs an open workspace folder.",
    );
    return;
  }
  if ((vscode.workspace.workspaceFolders?.length ?? 0) > 1) {
    vscode.window.showWarningMessage(
      "Multi-root workspace detected: only the first folder is tracked.",
    );
  }
  if (sessions.getActiveSession()) {
    vscode.window.showWarningMessage(
      "A session is already active. End it before starting a new one.",
    );
    return;
  }
  const title = await vscode.window.showInputBox({
    title: "Start Agent Session",
    prompt: "Describe what the agent is about to work on",
    placeHolder: "e.g. Fix login refresh issue",
  });
  if (!title) {
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Snapshotting workspace…" },
    async () => {
      try {
        const session = await sessions.startSession(title.trim());
        vscode.window.showInformationMessage(
          `Started session "${session.title}". Watching for changes.`,
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `Could not start session: ${(err as Error).message}`,
        );
      }
    },
  );
}

async function createCheckpoint(sessions: SessionManager): Promise<void> {
  const session = sessions.getActiveSession();
  if (!session) {
    vscode.window.showInformationMessage(
      "No active session — start one first.",
    );
    return;
  }
  if (session.pendingFiles.length === 0) {
    vscode.window.showInformationMessage(
      "No changes since the last checkpoint.",
    );
    return;
  }
  const label = await vscode.window.showInputBox({
    title: "Create Checkpoint",
    prompt: "Label for the work since the last checkpoint",
    value: session.currentTurnLabel ?? "",
    placeHolder: "e.g. Added retry logic to the API client",
  });
  if (!label) {
    return;
  }
  const checkpoint = await sessions.createCheckpoint(session, label.trim());
  if (checkpoint) {
    vscode.window.showInformationMessage(
      `Checkpoint "${checkpoint.label}" created (${checkpoint.files.length} files).`,
    );
  } else {
    vscode.window.showInformationMessage(
      "All pending files matched their previous state — nothing to checkpoint.",
    );
  }
}

async function restoreCheckpoint(
  sessions: SessionManager,
  node: Extract<TreeNode, { kind: "checkpoint" }> | undefined,
): Promise<void> {
  if (!node) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Restore the workspace to the end of "${node.checkpoint.label}"? ` +
      `Files changed by later turns are rewound; earlier work is kept.`,
    { modal: true },
    "Restore",
  );
  if (confirm !== "Restore") {
    return;
  }
  const { restored, skipped } = await sessions.restoreToCheckpoint(
    node.sessionId,
    node.index,
  );
  if (skipped.length > 0) {
    vscode.window.showWarningMessage(
      `Restored ${restored} file${restored === 1 ? "" : "s"}; could not restore: ${skipped.join(", ")}`,
    );
  } else {
    vscode.window.showInformationMessage(
      `Restored ${restored} file${restored === 1 ? "" : "s"} to "${node.checkpoint.label}".`,
    );
  }
}

async function openSourceMessage(
  source: AgentMessageSource | undefined,
): Promise<void> {
  if (!source) {
    vscode.window.showInformationMessage(
      "No original agent message link is available for this turn.",
    );
    return;
  }

  const externalUri = sourceExternalUri(source);
  if (externalUri) {
    try {
      const opened = await vscode.env.openExternal(
        vscode.Uri.parse(externalUri),
      );
      if (opened) {
        return;
      }
    } catch {
      // Fall back to the local transcript below.
    }
  }

  await openTranscriptLocation(source);
}

function sourceExternalUri(source: AgentMessageSource): string | undefined {
  if (!source.sessionId) {
    return undefined;
  }
  const id = encodeURIComponent(source.sessionId);
  if (source.agent === "codex") {
    return `codex://threads/${id}`;
  }
  return `${vscode.env.uriScheme}://anthropic.claude-code/open?session=${id}`;
}

async function openTranscriptLocation(
  source: AgentMessageSource,
): Promise<void> {
  try {
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(source.transcriptPath),
    );
    const editor = await vscode.window.showTextDocument(document, {
      preview: true,
    });
    if (source.lineNumber !== undefined && source.lineNumber > 0) {
      const line = Math.min(source.lineNumber - 1, document.lineCount - 1);
      const range = document.lineAt(line).range;
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    }
  } catch (err) {
    const agent = source.agent === "claude" ? "Claude Code" : "Codex";
    vscode.window.showWarningMessage(
      `Could not open the ${agent} source message: ${(err as Error).message}`,
    );
  }
}

async function openDiff(
  sessions: SessionManager,
  snapshots: SnapshotManager,
  node: Extract<TreeNode, { kind: "file" }> | undefined,
  column?: vscode.ViewColumn,
): Promise<void> {
  if (!node) {
    return;
  }
  const { sessionId, file } = node;
  const emptyUri = vscode.Uri.parse(`${EMPTY_SCHEME}:empty`);

  let left: vscode.Uri;
  let right: vscode.Uri;
  let title: string;

  if (node.checkpointIndex !== undefined) {
    // Turn diff: state at previous checkpoint ↔ state at this checkpoint.
    const session = sessions.getSession(sessionId);
    if (!session) {
      return;
    }
    if (file.status !== "deleted" && !node.blobHash) {
      vscode.window.showWarningMessage(
        `"${file.path}" was too large to store for this checkpoint and cannot be diffed.`,
      );
      return;
    }
    const pre = sessions.resolveStateAt(
      session,
      node.checkpointIndex - 1,
      file.path,
    );
    const preUri = stateUri(snapshots, sessionId, file.path, pre, emptyUri);
    if (!preUri) {
      vscode.window.showWarningMessage(
        `The previous state of "${file.path}" was too large to store and cannot be diffed.`,
      );
      return;
    }
    left = preUri;
    right =
      file.status === "deleted"
        ? emptyUri
        : snapshots.blobUri(sessionId, node.blobHash!);
    title = `${file.path} (turn ${node.checkpointIndex + 1})`;
  } else {
    // Cumulative diff: session baseline ↔ current workspace file.
    const workspaceUri = vscode.Uri.file(toAbsolutePath(file.path)!);
    const baselineUri = snapshots.baselineUri(sessionId, file.path);
    if (file.status === "created") {
      left = emptyUri; // no baseline
      right = workspaceUri;
    } else if (file.status === "deleted") {
      left = baselineUri;
      right = emptyUri; // file no longer exists
    } else {
      left = baselineUri;
      right = workspaceUri;
    }
    title = `${file.path} (baseline ↔ current)`;
  }

  // Binary content renders as garbage in the text diff; warn first.
  const checkPath = right.scheme === "file" ? right.fsPath : left.fsPath;
  if (checkPath && (await isProbablyBinary(checkPath))) {
    const choice = await vscode.window.showWarningMessage(
      `"${file.path}" looks like a binary file; the text diff may be unreadable.`,
      "Open Anyway",
    );
    if (choice !== "Open Anyway") {
      return;
    }
  }

  await vscode.commands.executeCommand(
    "vscode.diff",
    left,
    right,
    title,
    column === undefined ? undefined : { viewColumn: column, preview: true },
  );
}

/** URI for a resolved file state, or undefined if it cannot be shown. */
function stateUri(
  snapshots: SnapshotManager,
  sessionId: string,
  relPath: string,
  state: FileState,
  emptyUri: vscode.Uri,
): vscode.Uri | undefined {
  switch (state.kind) {
    case "blob":
      return snapshots.blobUri(sessionId, state.hash);
    case "baseline":
      return snapshots.baselineUri(sessionId, relPath);
    case "absent":
      return emptyUri;
    case "unknown":
      return undefined;
  }
}

async function revertFile(
  sessions: SessionManager,
  node: Extract<TreeNode, { kind: "file" }> | undefined,
): Promise<void> {
  if (!node) {
    return;
  }
  if (node.checkpointIndex !== undefined) {
    vscode.window.showInformationMessage(
      "Checkpoint entries are history — use \"Restore To Checkpoint\" on the checkpoint, or revert the file from the session's change list.",
    );
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Revert "${node.file.path}" to its baseline? This overwrites the current file.`,
    { modal: true },
    "Revert File",
  );
  if (confirm !== "Revert File") {
    return;
  }
  try {
    await sessions.revertSingleFile(node.sessionId, node.file);
    vscode.window.showInformationMessage(`Reverted ${node.file.path}.`);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Revert failed: ${(err as Error).message}`,
    );
  }
}

async function revertSession(
  sessions: SessionManager,
  session: AgentSession | undefined,
): Promise<void> {
  if (!session) {
    return;
  }
  const count = session.changedFiles.length;
  const confirm = await vscode.window.showWarningMessage(
    `Revert all ${count} file${count === 1 ? "" : "s"} in "${session.title}" to baseline?`,
    { modal: true },
    "Revert Session",
  );
  if (confirm !== "Revert Session") {
    return;
  }
  await sessions.revertSession(session.id);
  vscode.window.showInformationMessage(
    `Reverted session "${session.title}".`,
  );
}

async function markAccepted(
  sessions: SessionManager,
  session: AgentSession | undefined,
): Promise<void> {
  if (!session) {
    return;
  }
  await sessions.markAccepted(session.id);
  vscode.window.showInformationMessage(
    `Accepted session "${session.title}". Files kept; snapshot discarded.`,
  );
}

async function removeSession(
  sessions: SessionManager,
  session: AgentSession | undefined,
): Promise<void> {
  if (!session) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Remove session "${session.title}"? Its snapshot is deleted and its changes can no longer be reverted. Workspace files are not touched.`,
    { modal: true },
    "Remove Session",
  );
  if (confirm !== "Remove Session") {
    return;
  }
  await sessions.removeSession(session.id);
}

// ---- Command-palette pickers ----------------------------------------------

async function pickSession(
  sessions: SessionManager,
): Promise<AgentSession | undefined> {
  const all = sessions.getSessions();
  if (all.length === 0) {
    vscode.window.showInformationMessage("No agent sessions yet.");
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    all.map((s) => ({
      label: s.title,
      description: `${s.status} · ${s.changedFiles.length} files`,
      session: s,
    })),
    { title: "Select a session" },
  );
  return picked?.session;
}

async function pickFile(
  sessions: SessionManager,
): Promise<Extract<TreeNode, { kind: "file" }> | undefined> {
  const session = await pickSession(sessions);
  if (!session) {
    return undefined;
  }
  if (session.changedFiles.length === 0) {
    vscode.window.showInformationMessage("This session has no changed files.");
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    session.changedFiles.map((file) => ({
      label: file.path,
      description: file.status,
      file,
    })),
    { title: `Files in "${session.title}"` },
  );
  return picked
    ? { kind: "file", sessionId: session.id, file: picked.file }
    : undefined;
}

async function pickTurn(sessions: SessionManager): Promise<TurnRef | undefined> {
  const session = await pickSession(sessions);
  if (!session) {
    return undefined;
  }
  const items: (vscode.QuickPickItem & { ref: TurnRef })[] =
    session.checkpoints.map((checkpoint, index) => ({
      label: `${index + 1}. ${checkpoint.label}`,
      description: `${checkpoint.files.length} file${checkpoint.files.length === 1 ? "" : "s"}`,
      ref: { sessionId: session.id, checkpointId: checkpoint.id },
    }));
  if (session.status === "active" || session.pendingFiles.length > 0) {
    items.push({
      label: session.currentTurnLabel ?? "Current turn",
      description: "in progress",
      ref: { sessionId: session.id },
    });
  }
  if (items.length === 0) {
    vscode.window.showInformationMessage("This session has no turns yet.");
    return undefined;
  }
  if (items.length === 1) {
    return items[0].ref;
  }
  const picked = await vscode.window.showQuickPick(items.reverse(), {
    title: `Turns in "${session.title}"`,
  });
  return picked?.ref;
}

// ---- Argument coercion ----------------------------------------------------
// Commands may be invoked from a tree node (right-click) or the command
// palette (no argument). These helpers normalise the incoming value.

function asSession(node: unknown): AgentSession | undefined {
  if (
    node &&
    typeof node === "object" &&
    (node as TreeNode).kind === "session"
  ) {
    return (node as Extract<TreeNode, { kind: "session" }>).session;
  }
  return undefined;
}

function asCheckpoint(
  node: unknown,
): Extract<TreeNode, { kind: "checkpoint" }> | undefined {
  if (
    node &&
    typeof node === "object" &&
    (node as TreeNode).kind === "checkpoint"
  ) {
    return node as Extract<TreeNode, { kind: "checkpoint" }>;
  }
  return undefined;
}

function sourceFromNode(node: unknown): AgentMessageSource | undefined {
  if (!node || typeof node !== "object") {
    return undefined;
  }
  const treeNode = node as TreeNode;
  if (treeNode.kind === "checkpoint") {
    return treeNode.checkpoint.source;
  }
  if (treeNode.kind === "pendingGroup") {
    return treeNode.session.currentTurnSource;
  }
  return undefined;
}

/** The turn a tree node belongs to; a session maps to its latest turn. */
function turnRefFromNode(node: unknown): TurnRef | undefined {
  if (!node || typeof node !== "object") {
    return undefined;
  }
  const treeNode = node as TreeNode;
  switch (treeNode.kind) {
    case "checkpoint":
      return {
        sessionId: treeNode.sessionId,
        checkpointId: treeNode.checkpoint.id,
      };
    case "pendingGroup":
      return { sessionId: treeNode.session.id };
    case "session": {
      const { session } = treeNode;
      const latest = session.checkpoints[session.checkpoints.length - 1];
      const pending =
        session.status === "active" || session.pendingFiles.length > 0;
      return {
        sessionId: session.id,
        checkpointId: pending ? undefined : latest?.id,
      };
    }
    default:
      return undefined;
  }
}

function asFileNode(
  node: unknown,
): Extract<TreeNode, { kind: "file" }> | undefined {
  if (
    node &&
    typeof node === "object" &&
    (node as TreeNode).kind === "file"
  ) {
    return node as Extract<TreeNode, { kind: "file" }>;
  }
  return undefined;
}
