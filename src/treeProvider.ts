import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";
import {
  AgentChangedFile,
  AgentSession,
  ChangeStatus,
  Checkpoint,
} from "./types";

/**
 * Tree shape:
 *   session
 *   ├─ checkpoint #1 (one per agent turn)      — only when checkpoints exist
 *   │   └─ file (diff = that turn's pre ↔ post)
 *   ├─ "Current turn" group (pending changes)  — only when checkpoints exist
 *   │   └─ file (diff = baseline ↔ current)
 *   └─ file (diff = baseline ↔ current)        — flat, when no checkpoints
 */
export type TreeNode =
  | { kind: "session"; session: AgentSession }
  | {
      kind: "checkpoint";
      sessionId: string;
      index: number;
      checkpoint: Checkpoint;
    }
  | { kind: "pendingGroup"; session: AgentSession }
  | {
      kind: "file";
      sessionId: string;
      file: AgentChangedFile;
      /** Set when the file belongs to a checkpoint (turn diff). */
      checkpointIndex?: number;
      blobHash?: string;
    };

const STATUS_LABEL: Record<ChangeStatus, string> = {
  created: "Created",
  modified: "Modified",
  deleted: "Deleted",
};

const STATUS_ICON: Record<ChangeStatus, string> = {
  created: "diff-added",
  modified: "diff-modified",
  deleted: "diff-removed",
};

export class AgentTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly sessions: SessionManager) {
    sessions.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.kind) {
      case "session":
        return this.sessionItem(node.session);
      case "checkpoint":
        return this.checkpointItem(node.index, node.checkpoint);
      case "pendingGroup":
        return this.pendingGroupItem(node.session);
      case "file":
        return this.fileItem(node);
    }
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) {
      return this.sessions
        .getSessions()
        .map((session) => ({ kind: "session", session }) as TreeNode);
    }
    if (node.kind === "session") {
      const session = node.session;
      if (session.checkpoints.length === 0) {
        // Manual session without turn boundaries: flat cumulative list.
        return session.changedFiles.map(
          (file) =>
            ({ kind: "file", sessionId: session.id, file }) as TreeNode,
        );
      }
      const children: TreeNode[] = session.checkpoints.map(
        (checkpoint, index) =>
          ({
            kind: "checkpoint",
            sessionId: session.id,
            index,
            checkpoint,
          }) as TreeNode,
      );
      if (session.pendingFiles.length > 0 || session.status === "active") {
        children.push({ kind: "pendingGroup", session });
      }
      return children;
    }
    if (node.kind === "checkpoint") {
      return node.checkpoint.files.map(
        (file) =>
          ({
            kind: "file",
            sessionId: node.sessionId,
            file: { path: file.path, status: file.status },
            checkpointIndex: node.index,
            blobHash: file.blobHash,
          }) as TreeNode,
      );
    }
    if (node.kind === "pendingGroup") {
      return node.session.pendingFiles.map(
        (file) =>
          ({
            kind: "file",
            sessionId: node.session.id,
            file,
          }) as TreeNode,
      );
    }
    return [];
  }

  private sessionItem(session: AgentSession): vscode.TreeItem {
    const item = new vscode.TreeItem(
      session.title,
      vscode.TreeItemCollapsibleState.Expanded,
    );
    const count = session.changedFiles.length;
    const turns = session.checkpoints.length;
    item.description =
      `${session.status} · ${count} file${count === 1 ? "" : "s"}` +
      (turns > 0 ? ` · ${turns} turn${turns === 1 ? "" : "s"}` : "");
    item.tooltip = new vscode.MarkdownString(
      `**${session.title}**\n\n` +
        `Agent: ${session.agent}\n\n` +
        `Status: ${session.status}\n\n` +
        `Started: ${new Date(session.startedAt).toLocaleString()}`,
    );
    item.iconPath = new vscode.ThemeIcon(
      session.status === "active" ? "play-circle" : "history",
    );
    // contextValue drives the right-click menu; ".active" exposes End Session.
    item.contextValue =
      session.status === "active"
        ? "agentSession.active"
        : "agentSession";
    return item;
  }

  private checkpointItem(
    index: number,
    checkpoint: Checkpoint,
  ): vscode.TreeItem {
    const item = new vscode.TreeItem(
      `${index + 1}. ${checkpoint.label}`,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    const count = checkpoint.files.length;
    item.description = `${count} file${count === 1 ? "" : "s"}`;
    item.tooltip = new vscode.MarkdownString(
      `**${checkpoint.label}**\n\n` +
        `${new Date(checkpoint.createdAt).toLocaleString()}\n\n` +
        `Right-click to restore the workspace to this point.`,
    );
    item.iconPath = new vscode.ThemeIcon("milestone");
    item.contextValue = "agentCheckpoint";
    return item;
  }

  private pendingGroupItem(session: AgentSession): vscode.TreeItem {
    const count = session.pendingFiles.length;
    const item = new vscode.TreeItem(
      session.currentTurnLabel ?? "Current turn",
      count > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    item.description = `in progress · ${count} file${count === 1 ? "" : "s"}`;
    item.iconPath = new vscode.ThemeIcon("loading~spin");
    item.contextValue = "agentPendingGroup";
    return item;
  }

  private fileItem(
    node: Extract<TreeNode, { kind: "file" }>,
  ): vscode.TreeItem {
    const { file } = node;
    const item = new vscode.TreeItem(
      file.path,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = STATUS_LABEL[file.status];
    item.iconPath = new vscode.ThemeIcon(STATUS_ICON[file.status]);
    item.contextValue =
      node.checkpointIndex === undefined
        ? "agentChangedFile"
        : "agentCheckpointFile";
    // Clicking the row opens the diff.
    item.command = {
      command: "agentChangeGuard.openDiff",
      title: "Open Diff",
      arguments: [node],
    };
    return item;
  }
}
