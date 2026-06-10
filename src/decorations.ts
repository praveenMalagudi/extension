import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";
import { toRelativePath } from "./utils";

const STATUS_COLOR: Record<string, string> = {
  created: "gitDecoration.addedResourceForeground",
  modified: "gitDecoration.modifiedResourceForeground",
  deleted: "gitDecoration.deletedResourceForeground",
};

/**
 * Badges files changed during the active agent session in the Explorer and
 * editor tabs, so agent-touched files are visible without opening the view.
 */
export class AgentDecorationProvider
  implements vscode.FileDecorationProvider, vscode.Disposable
{
  private readonly _onDidChange = new vscode.EventEmitter<
    vscode.Uri | vscode.Uri[] | undefined
  >();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  private readonly registration: vscode.Disposable;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly sessions: SessionManager) {
    this.registration = vscode.window.registerFileDecorationProvider(this);
    // Refresh all decorations whenever session state changes.
    this.subscription = sessions.onDidChange(() =>
      this._onDidChange.fire(undefined),
    );
  }

  provideFileDecoration(
    uri: vscode.Uri,
  ): vscode.FileDecoration | undefined {
    if (uri.scheme !== "file") {
      return undefined;
    }
    const session = this.sessions.getActiveSession();
    if (!session) {
      return undefined;
    }
    const rel = toRelativePath(uri.fsPath);
    if (!rel) {
      return undefined;
    }
    const change = session.changedFiles.find((f) => f.path === rel);
    if (!change) {
      return undefined;
    }
    const decoration = new vscode.FileDecoration(
      "✦",
      `Changed during agent session "${session.title}" (${change.status})`,
      new vscode.ThemeColor(
        STATUS_COLOR[change.status] ??
          "gitDecoration.modifiedResourceForeground",
      ),
    );
    decoration.propagate = true;
    return decoration;
  }

  dispose(): void {
    this.registration.dispose();
    this.subscription.dispose();
    this._onDidChange.dispose();
  }
}
