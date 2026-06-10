import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";
import { SnapshotManager } from "./snapshotManager";
import { AgentTreeProvider, TreeNode } from "./treeProvider";
import { AgentSession } from "./types";
import { getWorkspaceFolder, toAbsolutePath } from "./utils";

/** Virtual scheme used to show an empty side in a diff (created/deleted). */
const EMPTY_SCHEME = "agentguard-empty";

export function activate(context: vscode.ExtensionContext): void {
  const snapshots = new SnapshotManager(context);
  const sessions = new SessionManager(context, snapshots);
  const tree = new AgentTreeProvider(sessions);

  context.subscriptions.push(
    sessions,
    vscode.window.registerTreeDataProvider("agentChangesView", tree),
    // Provides empty content for the "missing" side of created/deleted diffs.
    vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, {
      provideTextDocumentContent: () => "",
    }),
  );

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

  register("agentChangeGuard.openDiff", async (node?: unknown) =>
    openDiff(snapshots, asFileNode(node) ?? (await pickFile(sessions))),
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
}

export function deactivate(): void {
  // Subscriptions handle cleanup.
}

// ---- Command implementations ---------------------------------------------

async function startSession(sessions: SessionManager): Promise<void> {
  if (!getWorkspaceFolder()) {
    vscode.window.showErrorMessage(
      "Agent Change Guard needs an open workspace folder.",
    );
    return;
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
      const session = await sessions.startSession(title.trim());
      vscode.window.showInformationMessage(
        `Started session "${session.title}". Watching for changes.`,
      );
    },
  );
}

async function openDiff(
  snapshots: SnapshotManager,
  node: Extract<TreeNode, { kind: "file" }> | undefined,
): Promise<void> {
  if (!node) {
    return;
  }
  const { sessionId, file } = node;
  const emptyUri = vscode.Uri.parse(`${EMPTY_SCHEME}:empty`);
  const workspaceUri = vscode.Uri.file(toAbsolutePath(file.path)!);
  const baselineUri = snapshots.baselineUri(sessionId, file.path);

  let left: vscode.Uri;
  let right: vscode.Uri;
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

  const title = `${file.path} (baseline ↔ current)`;
  await vscode.commands.executeCommand("vscode.diff", left, right, title);
}

async function revertFile(
  sessions: SessionManager,
  node: Extract<TreeNode, { kind: "file" }> | undefined,
): Promise<void> {
  if (!node) {
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
