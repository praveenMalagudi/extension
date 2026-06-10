import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";
import { AgentChangedFile, AgentSession, ChangeStatus } from "./types";

/** A node is either a session (root) or a changed file (leaf). */
export type TreeNode =
  | { kind: "session"; session: AgentSession }
  | { kind: "file"; sessionId: string; file: AgentChangedFile };

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
    if (node.kind === "session") {
      return this.sessionItem(node.session);
    }
    return this.fileItem(node.sessionId, node.file);
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) {
      return this.sessions
        .getSessions()
        .map((session) => ({ kind: "session", session }) as TreeNode);
    }
    if (node.kind === "session") {
      return node.session.changedFiles.map(
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
    item.description = `${session.status} · ${count} file${
      count === 1 ? "" : "s"
    }`;
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

  private fileItem(
    sessionId: string,
    file: AgentChangedFile,
  ): vscode.TreeItem {
    const item = new vscode.TreeItem(
      file.path,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = STATUS_LABEL[file.status];
    item.iconPath = new vscode.ThemeIcon(STATUS_ICON[file.status]);
    item.contextValue = "agentChangedFile";
    // Clicking the row opens the diff.
    item.command = {
      command: "agentChangeGuard.openDiff",
      title: "Open Diff",
      arguments: [{ kind: "file", sessionId, file } as TreeNode],
    };
    return item;
  }
}
