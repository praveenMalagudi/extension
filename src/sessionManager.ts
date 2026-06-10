import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { SnapshotManager } from "./snapshotManager";
import {
  AgentChangedFile,
  AgentSession,
  AgentType,
  ChangeStatus,
} from "./types";
import {
  generateId,
  isIgnored,
  toAbsolutePath,
  toRelativePath,
} from "./utils";

const STORAGE_KEY = "agentChangeGuard.sessions";

/**
 * Owns all session state: persistence, the active session, the file watcher,
 * and the revert/accept operations. Fires onDidChange whenever the tree
 * should refresh.
 */
export class SessionManager {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private sessions: AgentSession[];
  private activeSessionId: string | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;

  /**
   * Paths we are about to write to during a revert. The watcher ignores
   * events for these so our own revert does not re-register as a change.
   */
  private readonly suppressed = new Set<string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly snapshots: SnapshotManager,
  ) {
    this.sessions = context.workspaceState.get<AgentSession[]>(
      STORAGE_KEY,
      [],
    );
    // Recover any session left "active" from a previous window: resume watching.
    this.activeSessionId = this.sessions.find(
      (s) => s.status === "active",
    )?.id;
    if (this.activeSessionId) {
      this.startWatching();
    }
  }

  // ---- Queries -----------------------------------------------------------

  getSessions(): AgentSession[] {
    return this.sessions;
  }

  getSession(id: string): AgentSession | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  getActiveSession(): AgentSession | undefined {
    return this.activeSessionId
      ? this.getSession(this.activeSessionId)
      : undefined;
  }

  // ---- Persistence -------------------------------------------------------

  private async persist(): Promise<void> {
    await this.context.workspaceState.update(STORAGE_KEY, this.sessions);
    this._onDidChange.fire();
  }

  // ---- Session lifecycle -------------------------------------------------

  async startSession(
    title: string,
    agent: AgentType = "manual",
  ): Promise<AgentSession> {
    if (this.activeSessionId) {
      throw new Error(
        "A session is already active. End it before starting a new one.",
      );
    }
    const session: AgentSession = {
      id: generateId(),
      title,
      agent,
      startedAt: Date.now(),
      changedFiles: [],
      status: "active",
    };
    // Snapshot the workspace before we start watching.
    await this.snapshots.createBaseline(session);
    this.sessions.unshift(session);
    this.activeSessionId = session.id;
    this.startWatching();
    await this.persist();
    return session;
  }

  async endSession(id?: string): Promise<void> {
    const sessionId = id ?? this.activeSessionId;
    const session = sessionId ? this.getSession(sessionId) : undefined;
    if (!session) {
      return;
    }
    if (session.status === "active") {
      session.status = "ended";
      session.endedAt = Date.now();
    }
    if (this.activeSessionId === session.id) {
      this.stopWatching();
      this.activeSessionId = undefined;
    }
    await this.persist();
  }

  // ---- File watching -----------------------------------------------------

  private startWatching(): void {
    if (this.watcher) {
      return;
    }
    // Watch everything under the workspace; ignored folders are filtered below.
    this.watcher = vscode.workspace.createFileSystemWatcher("**/*");
    this.watcher.onDidCreate((uri) => this.handleFsEvent(uri));
    this.watcher.onDidChange((uri) => this.handleFsEvent(uri));
    this.watcher.onDidDelete((uri) => this.handleFsEvent(uri));
  }

  private stopWatching(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
  }

  private handleFsEvent(uri: vscode.Uri): void {
    const session = this.getActiveSession();
    if (!session) {
      return;
    }
    const relPath = toRelativePath(uri.fsPath);
    if (!relPath || isIgnored(relPath)) {
      return;
    }
    if (this.suppressed.has(relPath)) {
      return;
    }
    this.recordChange(session, relPath);
  }

  /**
   * Recompute a file's status from its current existence and whether a
   * baseline exists. Robust regardless of which fs event fired.
   */
  private recordChange(session: AgentSession, relPath: string): void {
    const abs = toAbsolutePath(relPath);
    if (!abs) {
      return;
    }
    const exists = fs.existsSync(abs);
    const hasBaseline = this.snapshots.hasBaseline(session.id, relPath);

    let status: ChangeStatus | undefined;
    if (!exists) {
      // Deleted only matters if it existed at baseline. A file that was
      // created then deleted within the session is a net no-op.
      status = hasBaseline ? "deleted" : undefined;
    } else {
      status = hasBaseline ? "modified" : "created";
    }

    const existing = session.changedFiles.find((f) => f.path === relPath);
    if (status === undefined) {
      if (existing) {
        session.changedFiles = session.changedFiles.filter(
          (f) => f.path !== relPath,
        );
        void this.persist();
      }
      return;
    }
    if (existing) {
      if (existing.status !== status) {
        existing.status = status;
        void this.persist();
      }
      return;
    }
    session.changedFiles.push({ path: relPath, status });
    void this.persist();
  }

  // ---- Revert / accept ---------------------------------------------------

  /** Temporarily ignore watcher events for a path while we write to it. */
  private async withSuppressed(
    relPath: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    this.suppressed.add(relPath);
    try {
      await fn();
    } finally {
      // Clear after a short delay so the trailing fs event is also ignored.
      setTimeout(() => this.suppressed.delete(relPath), 750);
    }
  }

  /** Restore a single file to its baseline. */
  async revertFile(
    sessionId: string,
    file: AgentChangedFile,
  ): Promise<void> {
    const abs = toAbsolutePath(file.path);
    if (!abs) {
      throw new Error("File is outside the workspace.");
    }
    await this.withSuppressed(file.path, async () => {
      if (file.status === "created") {
        // Created during the session -> remove it.
        await fsp.rm(abs, { force: true });
      } else {
        // modified or deleted -> write baseline content back.
        const data = await this.snapshots.readBaseline(sessionId, file.path);
        if (data === undefined) {
          throw new Error(`No baseline stored for ${file.path}.`);
        }
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, data);
      }
    });
  }

  /** Revert one file and drop it from the session's change list. */
  async revertSingleFile(
    sessionId: string,
    file: AgentChangedFile,
  ): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session) {
      return;
    }
    await this.revertFile(sessionId, file);
    session.changedFiles = session.changedFiles.filter(
      (f) => f.path !== file.path,
    );
    await this.persist();
  }

  /** Revert every changed file in a session and mark it reverted. */
  async revertSession(sessionId: string): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session) {
      return;
    }
    for (const file of [...session.changedFiles]) {
      try {
        await this.revertFile(sessionId, file);
      } catch (err) {
        vscode.window.showWarningMessage(
          `Could not revert ${file.path}: ${(err as Error).message}`,
        );
      }
    }
    session.status = "reverted";
    if (this.activeSessionId === session.id) {
      this.stopWatching();
      this.activeSessionId = undefined;
    }
    await this.persist();
  }

  /** Accept a session: keep files, optionally discard snapshot data. */
  async markAccepted(
    sessionId: string,
    deleteSnapshot = true,
  ): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session) {
      return;
    }
    session.status = "accepted";
    if (!session.endedAt) {
      session.endedAt = Date.now();
    }
    if (this.activeSessionId === session.id) {
      this.stopWatching();
      this.activeSessionId = undefined;
    }
    if (deleteSnapshot) {
      await this.snapshots.deleteSnapshot(sessionId);
    }
    await this.persist();
  }

  dispose(): void {
    this.stopWatching();
    this._onDidChange.dispose();
  }
}
