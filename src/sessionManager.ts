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
  Checkpoint,
  CheckpointFile,
} from "./types";
import {
  generateId,
  getMaxSnapshotBytes,
  hashFile,
  isIgnored,
  toAbsolutePath,
  toRelativePath,
} from "./utils";

const STORAGE_KEY = "agentChangeGuard.sessions";
const PERSIST_DEBOUNCE_MS = 250;

/**
 * A file's resolved state at a given checkpoint boundary.
 * - blob:     content is the stored blob
 * - baseline: content is the session-start baseline copy
 * - absent:   the file did not exist at that point
 * - unknown:  the file changed but was too large to store
 */
export type FileState =
  | { kind: "blob"; hash: string }
  | { kind: "baseline" }
  | { kind: "absent" }
  | { kind: "unknown" };

/**
 * Owns all session state: persistence, the active session, the file watcher,
 * checkpoints, and the revert/accept/restore operations. Fires onDidChange
 * whenever the tree should refresh.
 */
export class SessionManager {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private sessions: AgentSession[];
  private activeSessionId: string | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;
  private persistTimer: NodeJS.Timeout | undefined;

  /**
   * Paths we are about to write to during a revert/restore. The watcher
   * ignores events for these so our own writes do not register as changes.
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
    // Migrate sessions stored by versions without checkpoints.
    for (const session of this.sessions) {
      session.checkpoints ??= [];
      session.pendingFiles ??= [];
    }
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

  /** Write immediately. Used for lifecycle operations (start/end/revert). */
  private async persist(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    await this.context.workspaceState.update(STORAGE_KEY, this.sessions);
    this._onDidChange.fire();
  }

  /**
   * Refresh the UI now but debounce the workspaceState write. Watcher events
   * can arrive in bursts of hundreds; one trailing write is enough.
   */
  private persistSoon(): void {
    this._onDidChange.fire();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.context.workspaceState.update(STORAGE_KEY, this.sessions);
    }, PERSIST_DEBOUNCE_MS);
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
      checkpoints: [],
      pendingFiles: [],
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
      // Fold the in-progress turn into a final checkpoint so the
      // turn-by-turn history is complete (only when there is a history).
      if (session.checkpoints.length > 0 && session.pendingFiles.length > 0) {
        await this.createCheckpoint(
          session,
          session.currentTurnLabel ?? "Final changes",
        );
      }
      session.status = "ended";
      session.endedAt = Date.now();
    }
    if (this.activeSessionId === session.id) {
      this.stopWatching();
      this.activeSessionId = undefined;
    }
    await this.persist();
  }

  /** Remove a session from the list and delete its snapshot data. */
  async removeSession(sessionId: string): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session) {
      return;
    }
    if (this.activeSessionId === sessionId) {
      this.stopWatching();
      this.activeSessionId = undefined;
    }
    await this.snapshots.deleteSnapshot(sessionId);
    this.sessions = this.sessions.filter((s) => s.id !== sessionId);
    await this.persist();
  }

  // ---- Checkpoints ---------------------------------------------------------

  /**
   * Resolve a file's state at the end of checkpoint `index` (-1 = baseline):
   * the most recent checkpoint at or before `index` that touched the path,
   * else the session baseline.
   */
  resolveStateAt(
    session: AgentSession,
    index: number,
    relPath: string,
  ): FileState {
    for (let i = Math.min(index, session.checkpoints.length - 1); i >= 0; i--) {
      const f = session.checkpoints[i].files.find((x) => x.path === relPath);
      if (f) {
        if (f.status === "deleted") {
          return { kind: "absent" };
        }
        return f.blobHash
          ? { kind: "blob", hash: f.blobHash }
          : { kind: "unknown" };
      }
    }
    return this.snapshots.hasBaseline(session.id, relPath)
      ? { kind: "baseline" }
      : { kind: "absent" };
  }

  /**
   * Close the in-progress turn: capture every pending file's current content
   * as a checkpoint. Files whose content matches their state at the previous
   * boundary are dropped (net no-op turns produce no checkpoint).
   */
  async createCheckpoint(
    session: AgentSession,
    label: string,
  ): Promise<Checkpoint | undefined> {
    const prevIndex = session.checkpoints.length - 1;
    const maxBytes = getMaxSnapshotBytes();
    const files: CheckpointFile[] = [];

    for (const pending of [...session.pendingFiles]) {
      const abs = toAbsolutePath(pending.path);
      if (!abs) {
        continue;
      }
      const pre = this.resolveStateAt(session, prevIndex, pending.path);
      let stat: fs.Stats | undefined;
      try {
        stat = await fsp.stat(abs);
      } catch {
        // File gone.
      }
      if (!stat) {
        if (pre.kind !== "absent") {
          files.push({ path: pending.path, status: "deleted" });
        }
        continue;
      }
      const status: ChangeStatus =
        pre.kind === "absent" ? "created" : "modified";
      if (stat.size > maxBytes) {
        // Too large to store: recorded, but not diffable/restorable.
        files.push({ path: pending.path, status });
        continue;
      }
      const curHash = await hashFile(abs);
      const preHash = await this.stateHash(session, pre, pending.path);
      if (curHash !== undefined && curHash === preHash) {
        continue; // No net change this turn.
      }
      const blobHash = await this.snapshots.storeBlob(session.id, abs);
      files.push({ path: pending.path, status, blobHash });
    }

    session.pendingFiles = [];
    if (files.length === 0) {
      await this.persist();
      return undefined;
    }
    const checkpoint: Checkpoint = {
      id: generateId(),
      label,
      createdAt: Date.now(),
      files,
    };
    session.checkpoints.push(checkpoint);
    await this.persist();
    return checkpoint;
  }

  /** Content hash of a resolved file state, for no-op detection. */
  private async stateHash(
    session: AgentSession,
    state: FileState,
    relPath: string,
  ): Promise<string | undefined> {
    if (state.kind === "blob") {
      return state.hash;
    }
    if (state.kind === "baseline") {
      return hashFile(this.snapshots.baselinePath(session.id, relPath));
    }
    return undefined;
  }

  /**
   * A new agent turn started. The changes accumulated so far belong to the
   * *previous* turn: fold them into a checkpoint labelled with that turn's
   * message, then remember the new message as the in-progress turn label.
   */
  async beginTurn(session: AgentSession, newLabel: string): Promise<void> {
    const previousLabel =
      session.currentTurnLabel ??
      (session.checkpoints.length === 0 ? "Changes before first message" : "Turn");
    if (session.pendingFiles.length > 0) {
      await this.createCheckpoint(session, previousLabel);
    }
    session.currentTurnLabel = newLabel;
    await this.persist();
  }

  /**
   * Restore every file to its state at the end of checkpoint `index`.
   * Files touched only by later checkpoints (or the in-progress turn) are
   * rewound; earlier work is left alone. History is kept.
   */
  async restoreToCheckpoint(
    sessionId: string,
    index: number,
  ): Promise<{ restored: number; skipped: string[] }> {
    const session = this.getSession(sessionId);
    if (!session) {
      return { restored: 0, skipped: [] };
    }
    const affected = new Set<string>();
    for (let i = index + 1; i < session.checkpoints.length; i++) {
      for (const f of session.checkpoints[i].files) {
        affected.add(f.path);
      }
    }
    for (const f of session.pendingFiles) {
      affected.add(f.path);
    }

    let restored = 0;
    const skipped: string[] = [];
    for (const relPath of affected) {
      const abs = toAbsolutePath(relPath);
      if (!abs) {
        skipped.push(relPath);
        continue;
      }
      const target = this.resolveStateAt(session, index, relPath);
      if (target.kind === "unknown") {
        skipped.push(relPath);
        continue;
      }
      try {
        await this.withSuppressed(relPath, async () => {
          if (target.kind === "absent") {
            await fsp.rm(abs, { force: true });
          } else {
            const data =
              target.kind === "blob"
                ? await this.snapshots.readBlob(session.id, target.hash)
                : await this.snapshots.readBaseline(session.id, relPath);
            if (data === undefined) {
              throw new Error("stored copy is missing");
            }
            await fsp.mkdir(path.dirname(abs), { recursive: true });
            await fsp.writeFile(abs, data);
          }
        });
        restored++;
      } catch {
        skipped.push(relPath);
        continue;
      }
      // Recompute cumulative + pending status from the restored content.
      await this.recordChange(session, relPath);
    }
    await this.persist();
    return { restored, skipped };
  }

  // ---- Reconciliation ------------------------------------------------------

  /**
   * Recompute the active session's change list from disk. Catches edits made
   * while the window was closed (the watcher only sees live events).
   */
  async reconcile(): Promise<void> {
    const session = this.getActiveSession();
    if (!session) {
      return;
    }
    const baselineFiles = await this.snapshots.listBaselineFiles(session.id);
    const baselineSet = new Set(baselineFiles);
    for (const rel of baselineFiles) {
      if (!isIgnored(rel)) {
        await this.recordChange(session, rel);
      }
    }
    // Files present now but absent from the baseline were created.
    await this.walkWorkspace(async (rel) => {
      if (!baselineSet.has(rel)) {
        await this.recordChange(session, rel);
      }
    });
    await this.persist();
  }

  private async walkWorkspace(
    cb: (relPath: string) => Promise<void>,
  ): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return;
    }
    const walk = async (current: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = path.join(current, entry.name);
        const rel = path.relative(root, abs).split(path.sep).join("/");
        if (isIgnored(rel)) {
          continue;
        }
        if (entry.isDirectory()) {
          await walk(abs);
        } else if (entry.isFile()) {
          await cb(rel);
        }
      }
    };
    await walk(root);
  }

  // ---- File watching -----------------------------------------------------

  private startWatching(): void {
    if (this.watcher) {
      return;
    }
    // Watch everything under the workspace; ignored paths are filtered below.
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
    void this.recordChange(session, relPath, true);
  }

  /**
   * Recompute a file's status from its current content and baseline. A file
   * whose content matches its baseline again (e.g. an undone edit or our own
   * revert) is dropped from the change list — content, not events, decides.
   * Updates both the cumulative list and the in-progress turn's pending list
   * (pending entries are re-checked against the previous checkpoint when the
   * turn is folded into a checkpoint).
   */
  private async recordChange(
    session: AgentSession,
    relPath: string,
    debounced = false,
  ): Promise<void> {
    const abs = toAbsolutePath(relPath);
    if (!abs) {
      return;
    }
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(abs);
    } catch {
      // Path no longer exists — treated as a potential deletion below.
    }
    if (stat?.isDirectory()) {
      return;
    }
    const exists = stat !== undefined;
    const hasBaseline = this.snapshots.hasBaseline(session.id, relPath);

    let status: ChangeStatus | undefined;
    if (!exists) {
      // Deleted only matters if it existed at baseline. A file that was
      // created then deleted within the session is a net no-op.
      status = hasBaseline ? "deleted" : undefined;
    } else if (!hasBaseline) {
      status = "created";
    } else {
      status = (await this.differsFromBaseline(session.id, relPath, abs))
        ? "modified"
        : undefined;
    }

    const upsert = (list: AgentChangedFile[], s: ChangeStatus): boolean => {
      const existing = list.find((f) => f.path === relPath);
      if (existing) {
        if (existing.status === s) {
          return false;
        }
        existing.status = s;
        return true;
      }
      list.push({ path: relPath, status: s });
      return true;
    };
    const remove = (list: AgentChangedFile[]): boolean => {
      const before = list.length;
      const filtered = list.filter((f) => f.path !== relPath);
      list.length = 0;
      list.push(...filtered);
      return filtered.length !== before;
    };

    let changed: boolean;
    if (status === undefined) {
      changed = remove(session.changedFiles);
      changed = remove(session.pendingFiles) || changed;
    } else {
      changed = upsert(session.changedFiles, status);
      changed = upsert(session.pendingFiles, status) || changed;
    }
    if (changed) {
      debounced ? this.persistSoon() : void this.persist();
    }
  }

  /** Compare a workspace file against its baseline: size first, then hash. */
  private async differsFromBaseline(
    sessionId: string,
    relPath: string,
    abs: string,
  ): Promise<boolean> {
    const baselineAbs = this.snapshots.baselinePath(sessionId, relPath);
    try {
      const [curStat, baseStat] = await Promise.all([
        fsp.stat(abs),
        fsp.stat(baselineAbs),
      ]);
      if (curStat.size !== baseStat.size) {
        return true;
      }
    } catch {
      return true;
    }
    const [curHash, baseHash] = await Promise.all([
      hashFile(abs),
      hashFile(baselineAbs),
    ]);
    return curHash === undefined || curHash !== baseHash;
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
      // Even if a late event slips through, recordChange compares content
      // against the baseline and treats a reverted file as unchanged.
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
    session.pendingFiles = session.pendingFiles.filter(
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
    session.pendingFiles = [];
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
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      // Flush the pending debounced write so no changes are lost on close.
      void this.context.workspaceState.update(STORAGE_KEY, this.sessions);
    }
    this._onDidChange.dispose();
  }
}
