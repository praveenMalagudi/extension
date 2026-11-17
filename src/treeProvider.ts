import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";
import { TurnTraces, pathKey, unexplainedChanges } from "./turnTrace";
import {
  AgentChangedFile,
  AgentSession,
  ChangeStatus,
  Checkpoint,
  CheckpointFile,
  StepKind,
  StepStatus,
  TurnStep,
} from "./types";
import { toAbsolutePath } from "./utils";

/**
 * Tree shape:
 *   session
 *   ├─ checkpoint #1 (one per agent turn)      — only when checkpoints exist
 *   │   ├─ file (diff = that turn's pre ↔ post)
 *   │   └─ "Agent steps" (from the transcript) — when the turn has one
 *   │       └─ step (└─ subagent steps)
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
      /** Changed in its turn, but no recorded agent step wrote it. */
      unexplained?: boolean;
    }
  | {
      kind: "stepsGroup";
      sessionId: string;
      checkpointIndex: number;
      steps: TurnStep[];
      /** The checkpoint's files, so a step can open its turn diff. */
      changed: CheckpointFile[];
    }
  | {
      kind: "step";
      sessionId: string;
      checkpointIndex: number;
      step: TurnStep;
      changed: CheckpointFile[];
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

const STEP_LABEL: Record<StepKind, string> = {
  read: "Read",
  search: "Search",
  edit: "Edit",
  write: "Write",
  delete: "Delete",
  command: "Run",
  agent: "Subagent",
  web: "Web",
  message: "Message",
  other: "Tool",
};

const STEP_ICON: Record<StepKind, string> = {
  read: "eye",
  search: "search",
  edit: "edit",
  write: "new-file",
  delete: "trash",
  command: "terminal",
  agent: "hubot",
  web: "globe",
  message: "comment",
  other: "tools",
};

const STEP_STATUS_LABEL: Partial<Record<StepStatus, string>> = {
  error: "failed",
  rejected: "rejected",
  interrupted: "interrupted",
  running: "running",
};

export class AgentTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly sessions: SessionManager,
    private readonly traces: TurnTraces,
  ) {
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
      case "stepsGroup":
        return this.stepsGroupItem(node);
      case "step":
        return this.stepItem(node);
    }
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
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
      const { checkpoint } = node;
      const trace = checkpoint.source
        ? await this.traces.get(checkpoint.source, true, checkpoint.label)
        : undefined;
      const unexplained = trace
        ? unexplainedChanges(checkpoint.files, trace)
        : new Set<string>();
      const children: TreeNode[] = checkpoint.files.map((file) => ({
        kind: "file",
        sessionId: node.sessionId,
        file: { path: file.path, status: file.status },
        checkpointIndex: node.index,
        blobHash: file.blobHash,
        unexplained: unexplained.has(file.path),
      }));
      const steps = toolSteps(trace?.steps ?? []);
      if (steps.length > 0) {
        children.push({
          kind: "stepsGroup",
          sessionId: node.sessionId,
          checkpointIndex: node.index,
          steps,
          changed: checkpoint.files,
        });
      }
      return children;
    }
    if (node.kind === "stepsGroup" || node.kind === "step") {
      const steps =
        node.kind === "stepsGroup"
          ? node.steps
          : toolSteps(node.step.children ?? []);
      return steps.map((step) => ({
        kind: "step",
        sessionId: node.sessionId,
        checkpointIndex: node.checkpointIndex,
        step,
        changed: node.changed,
      }));
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
        sourceTooltip(checkpoint.source) +
        `Right-click to restore the workspace to this point.`,
    );
    item.iconPath = new vscode.ThemeIcon("milestone");
    item.contextValue = checkpoint.source
      ? "agentCheckpoint.source"
      : "agentCheckpoint";
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
    item.contextValue = session.currentTurnSource
      ? "agentPendingGroup.source"
      : "agentPendingGroup";
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
    if (node.unexplained) {
      item.description = `${STATUS_LABEL[file.status]} · no agent edit`;
      item.iconPath = new vscode.ThemeIcon(
        "warning",
        new vscode.ThemeColor("list.warningForeground"),
      );
      item.tooltip =
        `${file.path}\n\nChanged in this turn, but no recorded agent step ` +
        `wrote it. It may have been changed by a shell command, a formatter ` +
        `or build step, another tool, or by you.`;
    }
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

  private stepsGroupItem(
    node: Extract<TreeNode, { kind: "stepsGroup" }>,
  ): vscode.TreeItem {
    const item = new vscode.TreeItem(
      "Agent steps",
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    const count = node.steps.length;
    item.description = `${count} step${count === 1 ? "" : "s"}`;
    item.tooltip =
      "What the agent did during this turn, read from its transcript. " +
      "Use Show Turn Flow for the full flowchart and replay.";
    item.iconPath = new vscode.ThemeIcon("workflow");
    item.contextValue = "agentStepsGroup";
    return item;
  }

  private stepItem(node: Extract<TreeNode, { kind: "step" }>): vscode.TreeItem {
    const { step } = node;
    const subSteps = toolSteps(step.children ?? []);
    const item = new vscode.TreeItem(
      step.title,
      subSteps.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    const parts = [STEP_LABEL[step.kind]];
    if (step.added !== undefined || step.removed !== undefined) {
      parts.push(`+${step.added ?? 0} −${step.removed ?? 0}`);
    }
    const status = STEP_STATUS_LABEL[step.status];
    if (status) {
      parts.push(status);
    }
    item.description = parts.join(" · ");
    const color =
      step.status === "error" || step.status === "interrupted"
        ? new vscode.ThemeColor("errorForeground")
        : step.status === "rejected"
          ? new vscode.ThemeColor("list.warningForeground")
          : undefined;
    item.iconPath = new vscode.ThemeIcon(STEP_ICON[step.kind], color);
    item.tooltip = stepTooltip(step);
    item.contextValue = "agentStep";

    // Click: the turn diff of a file this step changed, else the file it read.
    const written = node.changed.find((c) =>
      step.files.some(
        (f) => f.access === "write" && pathKey(f.path) === pathKey(c.path),
      ),
    );
    if (written) {
      const fileNode: TreeNode = {
        kind: "file",
        sessionId: node.sessionId,
        file: { path: written.path, status: written.status },
        checkpointIndex: node.checkpointIndex,
        blobHash: written.blobHash,
      };
      item.command = {
        command: "agentChangeGuard.openDiff",
        title: "Open Diff",
        arguments: [fileNode],
      };
    } else {
      const read = step.files.find((f) => f.inWorkspace);
      const abs = read && toAbsolutePath(read.path);
      if (abs) {
        item.command = {
          command: "vscode.open",
          title: "Open File",
          arguments: [vscode.Uri.file(abs)],
        };
      }
    }
    return item;
  }
}

/** Steps worth listing in the tree: tool calls, not the agent's messages. */
function toolSteps(steps: TurnStep[]): TurnStep[] {
  return steps.filter((s) => s.kind !== "message");
}

function stepTooltip(step: TurnStep): vscode.MarkdownString {
  // Built with appendText/appendCodeblock: transcript text is never
  // interpreted as markdown.
  const md = new vscode.MarkdownString();
  md.appendText(`${STEP_LABEL[step.kind]} (${step.tool}): ${step.title}\n\n`);
  if (step.note) {
    md.appendText(`${step.note}\n\n`);
  }
  const status = STEP_STATUS_LABEL[step.status];
  if (status) {
    md.appendText(`Status: ${status}\n\n`);
  }
  if (step.userModified) {
    md.appendText("You edited this change before it was applied.\n\n");
  }
  for (const file of step.files) {
    md.appendText(
      `${file.access === "write" ? "Wrote" : "Read"}: ${file.path}` +
        `${file.inWorkspace ? "" : " (outside the workspace)"}\n\n`,
    );
  }
  if (step.detail && step.detail !== step.title) {
    md.appendCodeblock(step.detail, step.kind === "command" ? "shellscript" : "");
  }
  return md;
}

function sourceTooltip(source: Checkpoint["source"]): string {
  if (!source) {
    return "";
  }
  const label = source.agent === "claude" ? "Claude Code" : "Codex";
  const session = source.sessionId ? ` session ${source.sessionId}` : "";
  return `Source: ${label}${session}\n\n`;
}
