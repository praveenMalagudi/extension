import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { AgentSession } from "./types";
import {
  IGNORED_DIRS,
  MAX_SNAPSHOT_BYTES,
  getWorkspaceFolder,
} from "./utils";

/**
 * Manages baseline snapshots of workspace files.
 *
 * For the MVP we copy raw file contents into a hidden extension storage
 * folder. We never touch git state. A baseline is the content of a file at
 * the moment the session started; revert restores from these copies.
 *
 * Layout:
 *   <storageRoot>/snapshots/<sessionId>/<relative/path/to/file>
 */
export class SnapshotManager {
  private readonly storageRoot: string;

  constructor(context: vscode.ExtensionContext) {
    // storageUri is per-workspace; fall back to global storage if absent.
    const base = context.storageUri ?? context.globalStorageUri;
    this.storageRoot = path.join(base.fsPath, "snapshots");
  }

  private sessionDir(sessionId: string): string {
    return path.join(this.storageRoot, sessionId);
  }

  /** Absolute path of a file's baseline copy inside the snapshot store. */
  private baselinePath(sessionId: string, relPath: string): string {
    return path.join(this.sessionDir(sessionId), ...relPath.split("/"));
  }

  /** URI to a file's baseline copy (used as the left side of a diff). */
  baselineUri(sessionId: string, relPath: string): vscode.Uri {
    return vscode.Uri.file(this.baselinePath(sessionId, relPath));
  }

  /** True if a baseline copy exists for this file (i.e. it existed at start). */
  hasBaseline(sessionId: string, relPath: string): boolean {
    return fs.existsSync(this.baselinePath(sessionId, relPath));
  }

  /** Read a baseline file's bytes, or undefined if it does not exist. */
  async readBaseline(
    sessionId: string,
    relPath: string,
  ): Promise<Buffer | undefined> {
    const p = this.baselinePath(sessionId, relPath);
    try {
      return await fsp.readFile(p);
    } catch {
      return undefined;
    }
  }

  /**
   * Snapshot the current workspace into this session's baseline folder.
   * Captured at session start so we have the original content of every file
   * that might later be modified or deleted. Ignored folders are skipped, as
   * are files larger than MAX_SNAPSHOT_BYTES (those become un-revertable).
   */
  async createBaseline(session: AgentSession): Promise<void> {
    const folder = getWorkspaceFolder();
    if (!folder) {
      throw new Error("No workspace folder open.");
    }
    const root = folder.uri.fsPath;
    const dest = this.sessionDir(session.id);
    await fsp.mkdir(dest, { recursive: true });
    await this.copyTree(root, root, dest);
  }

  /** Recursively copy a directory tree, skipping ignored folders. */
  private async copyTree(
    root: string,
    current: string,
    destRoot: string,
  ): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        await this.copyTree(root, abs, destRoot);
      } else if (entry.isFile()) {
        try {
          const stat = await fsp.stat(abs);
          if (stat.size > MAX_SNAPSHOT_BYTES) {
            continue;
          }
          const rel = path.relative(root, abs);
          const target = path.join(destRoot, rel);
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await fsp.copyFile(abs, target);
        } catch {
          // Ignore unreadable files (permissions, symlinks, etc.).
        }
      }
    }
  }

  /** Remove all snapshot data for a session. */
  async deleteSnapshot(sessionId: string): Promise<void> {
    await fsp.rm(this.sessionDir(sessionId), {
      recursive: true,
      force: true,
    });
  }
}
