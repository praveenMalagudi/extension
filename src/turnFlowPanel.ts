import { randomBytes } from "crypto";
import * as fsp from "fs/promises";
import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";
import { TreeNode } from "./treeProvider";
import {
  TurnTraces,
  collectWriters,
  pathKey,
  unexplainedChanges,
  walkSteps,
} from "./turnTrace";
import {
  AgentChangedFile,
  AgentMessageSource,
  AgentSession,
  AgentType,
  ChangeStatus,
  CheckpointFile,
  TurnStep,
} from "./types";
import { isIgnored, toAbsolutePath } from "./utils";

const LIVE_POLL_MS = 1500;
const REFRESH_DEBOUNCE_MS = 300;

/** A turn: a checkpoint by id, or the session's in-progress turn. */
export interface TurnRef {
  sessionId: string;
  /** Undefined = the in-progress turn. */
  checkpointId?: string;
}

/** Editor actions the panel delegates back to the extension. */
export interface TurnFlowActions {
  openDiff(
    node: Extract<TreeNode, { kind: "file" }>,
    column: vscode.ViewColumn,
  ): Promise<void>;
  openSource(source: AgentMessageSource): Promise<void>;
}

/** A file in the panel's file list. */
interface FlowFile {
  path: string;
  inWorkspace: boolean;
  /** How the turn changed it; undefined for files the agent only read. */
  status?: ChangeStatus;
  /** False = changed with no matching agent step. Undefined = not checked. */
  explained?: boolean;
  added?: number;
  removed?: number;
  canDiff: boolean;
}

/** Everything the webview renders. Sent as JSON. */
interface FlowModel {
  /** Identity of the turn, so the webview keeps replay state on updates. */
  key: string;
  sessionTitle: string;
  agent: AgentType;
  position: string;
  hasPrev: boolean;
  hasNext: boolean;
  /** In-progress turn of an active session: the view updates live. */
  live: boolean;
  label: string;
  prompt: string;
  time: number;
  startedAt?: number;
  endedAt?: number;
  hasSource: boolean;
  /** none = no transcript linked; unavailable = linked but unreadable. */
  trace: "ok" | "none" | "unavailable";
  truncated: boolean;
  /** Whether "explained" flags were computed (closed turn, full trace). */
  attribution: boolean;
  steps: TurnStep[];
  changed: FlowFile[];
  read: FlowFile[];
  /** Workspace paths the agent wrote that tracking ignores. */
  ignored: string[];
}

/**
 * The Turn Flow webview: one turn drawn as a flowchart, from the user's
 * message through every step the agent took to the files that changed, with
 * an animated replay. A single panel is reused; it follows the in-progress
 * turn live and keeps showing it after it becomes a checkpoint.
 */
export class TurnFlowPanel {
  static readonly viewType = "agentChangeGuard.turnFlow";
  private static current: TurnFlowPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private ref: TurnRef;
  /** Source of the in-progress turn being shown, to follow it into its checkpoint. */
  private liveSource: AgentMessageSource | undefined;
  private liveSize = -1;
  private liveTimer: NodeJS.Timeout | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshSeq = 0;
  private model: FlowModel | undefined;
  private disposed = false;

  static show(
    extensionUri: vscode.Uri,
    sessions: SessionManager,
    traces: TurnTraces,
    actions: TurnFlowActions,
    ref: TurnRef,
  ): void {
    const existing = TurnFlowPanel.current;
    if (existing) {
      existing.setTurn(ref);
      existing.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      TurnFlowPanel.viewType,
      "Turn Flow",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      },
    );
    TurnFlowPanel.current = new TurnFlowPanel(
      panel,
      extensionUri,
      sessions,
      traces,
      actions,
      ref,
    );
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly sessions: SessionManager,
    private readonly traces: TurnTraces,
    private readonly actions: TurnFlowActions,
    ref: TurnRef,
  ) {
    this.ref = ref;
    panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.png");
    panel.webview.html = this.html();
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.onDidChangeViewState(() => this.updateLivePolling()),
      panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg)),
      sessions.onDidChange(() => this.scheduleRefresh()),
    );
  }

  private setTurn(ref: TurnRef): void {
    this.ref = ref;
    this.liveSource = undefined;
    void this.refresh();
  }

  // ---- Webview messages ----------------------------------------------------

  private onMessage(msg: any): void {
    switch (msg?.type) {
      case "ready":
        void this.refresh();
        return;
      case "navigate":
        this.navigate(msg.delta === -1 ? -1 : 1);
        return;
      case "openDiff":
        void this.openDiff(String(msg.path));
        return;
      case "openFile":
        void this.openFile(String(msg.path));
        return;
      case "openSource": {
        const source = this.resolve()?.source;
        if (source) {
          void this.actions.openSource(source);
        }
        return;
      }
    }
  }

  private navigate(delta: -1 | 1): void {
    const resolved = this.resolve();
    if (!resolved) {
      return;
    }
    const { session, index } = resolved;
    const target = index + delta;
    if (target < 0 || target > lastIndex(session)) {
      return;
    }
    this.setTurn({
      sessionId: session.id,
      checkpointId: session.checkpoints[target]?.id,
    });
  }

  private async openDiff(relPath: string): Promise<void> {
    const resolved = this.resolve();
    if (!resolved) {
      return;
    }
    const { session, checkpoint, index } = resolved;
    let node: Extract<TreeNode, { kind: "file" }> | undefined;
    if (checkpoint) {
      const file = checkpoint.files.find((f) => f.path === relPath);
      node = file && {
        kind: "file",
        sessionId: session.id,
        file: { path: file.path, status: file.status },
        checkpointIndex: index,
        blobHash: file.blobHash,
      };
    } else {
      const file = session.pendingFiles.find((f) => f.path === relPath);
      node = file && { kind: "file", sessionId: session.id, file };
    }
    if (node) {
      await this.actions.openDiff(node, this.editorColumn());
    }
  }

  private async openFile(filePath: string): Promise<void> {
    const entry = this.findFile(filePath);
    if (!entry) {
      return;
    }
    const abs = entry.inWorkspace ? toAbsolutePath(entry.path) : entry.path;
    try {
      if (!abs || !(await fsp.stat(abs)).isFile()) {
        throw new Error();
      }
    } catch {
      vscode.window.showInformationMessage(
        `"${filePath}" no longer exists.`,
      );
      return;
    }
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(abs), {
      viewColumn: this.editorColumn(),
      preview: true,
    });
  }

  /** Only paths the rendered turn references may be opened. */
  private findFile(
    filePath: string,
  ): { path: string; inWorkspace: boolean } | undefined {
    const model = this.model;
    if (!model) {
      return undefined;
    }
    let found: { path: string; inWorkspace: boolean } | undefined = [
      ...model.changed,
      ...model.read,
    ].find((f) => f.path === filePath);
    walkSteps(model.steps, (step) => {
      found ??= step.files.find((f) => f.path === filePath);
    });
    return found;
  }

  /** Open editors next to the panel rather than on top of it. */
  private editorColumn(): vscode.ViewColumn {
    return this.panel.viewColumn === vscode.ViewColumn.One
      ? vscode.ViewColumn.Two
      : vscode.ViewColumn.One;
  }

  // ---- Refresh -------------------------------------------------------------

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  private async refresh(): Promise<void> {
    const seq = ++this.refreshSeq;
    const model = await this.buildModel();
    if (seq !== this.refreshSeq || this.disposed) {
      return; // A newer refresh started meanwhile.
    }
    this.model = model;
    this.panel.title = model
      ? `Turn Flow · ${truncate(model.label, 40)}`
      : "Turn Flow";
    void this.panel.webview.postMessage({ type: "render", model: model ?? null });
    this.updateLivePolling();
  }

  /**
   * Agents write steps that change no files (reads, commands), so the
   * session's change events alone would miss them: while the in-progress
   * turn is on screen, poll its transcript and refresh when it grows.
   */
  private updateLivePolling(): void {
    const live = this.panel.visible && this.model?.live && this.liveSource;
    if (!live) {
      if (this.liveTimer) {
        clearInterval(this.liveTimer);
        this.liveTimer = undefined;
      }
      return;
    }
    this.liveTimer ??= setInterval(async () => {
      const source = this.liveSource;
      if (!source) {
        return;
      }
      let size = -1;
      try {
        size = (await fsp.stat(source.transcriptPath)).size;
      } catch {
        // Transcript gone; nothing to follow.
      }
      if (size !== this.liveSize) {
        this.liveSize = size;
        void this.refresh();
      }
    }, LIVE_POLL_MS);
  }

  /** The session and turn the panel shows, following a closed live turn. */
  private resolve():
    | {
        session: AgentSession;
        index: number;
        checkpoint?: AgentSession["checkpoints"][number];
        source?: AgentMessageSource;
      }
    | undefined {
    const session = this.sessions.getSession(this.ref.sessionId);
    if (!session) {
      return undefined;
    }
    if (!this.ref.checkpointId && this.liveSource) {
      const current = session.currentTurnSource;
      if (!current || !sameSource(current, this.liveSource)) {
        // The turn we were following was folded into a checkpoint.
        const closed = session.checkpoints.find(
          (c) => c.source && sameSource(c.source, this.liveSource!),
        );
        if (closed) {
          this.ref = { sessionId: session.id, checkpointId: closed.id };
        }
        this.liveSource = undefined;
      }
    }
    if (this.ref.checkpointId) {
      const index = session.checkpoints.findIndex(
        (c) => c.id === this.ref.checkpointId,
      );
      if (index === -1) {
        return undefined;
      }
      const checkpoint = session.checkpoints[index];
      return { session, index, checkpoint, source: checkpoint.source };
    }
    this.liveSource ??= session.currentTurnSource;
    return {
      session,
      index: session.checkpoints.length,
      source: session.currentTurnSource,
    };
  }

  private async buildModel(): Promise<FlowModel | undefined> {
    const resolved = this.resolve();
    if (!resolved) {
      return undefined;
    }
    const { session, index, checkpoint, source } = resolved;
    const closed = checkpoint !== undefined;
    const turnLabel = checkpoint ? checkpoint.label : session.currentTurnLabel;
    const trace = source
      ? await this.traces.get(source, closed, turnLabel)
      : undefined;
    const steps = trace?.steps ?? [];

    const files: (CheckpointFile | AgentChangedFile)[] = checkpoint
      ? checkpoint.files
      : session.pendingFiles;
    // Only a finished turn with a complete trace can be checked: in a
    // running turn, a command may not have reported its edits yet.
    const attribution = closed && trace !== undefined && !trace.truncated;
    const unexplained = attribution
      ? unexplainedChanges(files, trace!)
      : new Set<string>();
    const writers = collectWriters(steps);

    const changedKeys = new Set(files.map((f) => pathKey(f.path)));
    const changed: FlowFile[] = files.map((f) => {
      let added: number | undefined;
      let removed: number | undefined;
      for (const step of writers.get(pathKey(f.path)) ?? []) {
        // Line counts are per step; only single-file steps can be summed.
        const counted = step.added !== undefined || step.removed !== undefined;
        if (counted && step.files.filter((x) => x.access === "write").length === 1) {
          added = (added ?? 0) + (step.added ?? 0);
          removed = (removed ?? 0) + (step.removed ?? 0);
        }
      }
      return {
        path: f.path,
        inWorkspace: true,
        status: f.status,
        ...(attribution ? { explained: !unexplained.has(f.path) } : {}),
        ...(added !== undefined ? { added, removed } : {}),
        // Files over the size limit have no stored copy to diff.
        canDiff:
          !checkpoint ||
          f.status === "deleted" ||
          ("blobHash" in f && f.blobHash !== undefined),
      };
    });

    const read: FlowFile[] = [];
    const seen = new Set(changedKeys);
    const ignored = new Set<string>();
    walkSteps(steps, (step) => {
      for (const f of step.files) {
        const key = pathKey(f.path);
        if (f.access === "write") {
          if (f.inWorkspace && !changedKeys.has(key) && isIgnored(f.path)) {
            ignored.add(f.path);
          }
          continue;
        }
        if (!seen.has(key)) {
          seen.add(key);
          read.push({ path: f.path, inWorkspace: f.inWorkspace, canDiff: false });
        }
      }
    });

    const label = checkpoint?.label ?? session.currentTurnLabel ?? "Current turn";
    const live = !closed && session.status === "active";
    return {
      key: `${session.id}:${checkpoint?.id ?? "pending"}`,
      sessionTitle: session.title,
      agent: source?.agent ?? session.agent,
      position: closed
        ? `Turn ${index + 1} of ${session.checkpoints.length}`
        : live
          ? "Current turn"
          : "Uncheckpointed changes",
      hasPrev: index > 0,
      hasNext: index < lastIndex(session),
      live,
      label,
      prompt: trace?.prompt ?? label,
      time: checkpoint?.createdAt ?? trace?.startedAt ?? session.startedAt,
      startedAt: trace?.startedAt,
      endedAt: trace?.endedAt,
      hasSource: source !== undefined,
      trace: !source ? "none" : trace ? "ok" : "unavailable",
      truncated: trace?.truncated ?? false,
      attribution,
      steps,
      changed,
      read,
      ignored: [...ignored],
    };
  }

  private html(): string {
    const webview = this.panel.webview;
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(media, "turnFlow.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(media, "turnFlow.css"));
    const nonce = randomBytes(16).toString("hex");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Turn Flow</title>
</head>
<body>
<main id="app" class="app"></main>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    TurnFlowPanel.current = undefined;
    if (this.liveTimer) {
      clearInterval(this.liveTimer);
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.disposables.forEach((d) => d.dispose());
    this.panel.dispose();
  }
}

/** Index of the last navigable turn: the in-progress turn counts when present. */
function lastIndex(session: AgentSession): number {
  const hasPending =
    session.status === "active" || session.pendingFiles.length > 0;
  return session.checkpoints.length - (hasPending ? 0 : 1);
}

function sameSource(a: AgentMessageSource, b: AgentMessageSource): boolean {
  return a.transcriptPath === b.transcriptPath && a.lineNumber === b.lineNumber;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
