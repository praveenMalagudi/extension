import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { AgentSession } from "./types";
import {
  getIgnoredDirs,
  getMaxSnapshotBytes,
  getWorkspaceFolder,
  hashFile,
  isIgnored,
} from "./utils";

/**
 * Manages baseline snapshots of workspace files.
 *
 * Raw file contents are copied into a hidden extension storage folder. We
 * never touch git state. A baseline is the content of a file at the moment
 * the session started; revert restores from these copies.
 *
 * Layout:
 *   <storageRoot>/snapshots/<sessionId>/<relative/path/to/file>   (baseline)
 *   <storageRoot>/blobs/<sessionId>/<sha1>                        (checkpoints)
 */
export class SnapshotManager {
  private readonly storageRoot: string;
  private readonly blobRoot: string;

  constructor(context: vscode.ExtensionContext) {
    // storageUri is per-workspace; fall back to global storage if absent.
    const base = context.storageUri ?? context.globalStorageUri;
    this.storageRoot = path.join(base.fsPath, "snapshots");
    this.blobRoot = path.join(base.fsPath, "blobs");
  }

  private sessionDir(sessionId: string): string {
    return path.join(this.storageRoot, sessionId);
  }

  /** Absolute path of a file's baseline copy inside the snapshot store. */
  baselinePath(sessionId: string, relPath: string): string {
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
   * Enumerate the relative paths of every file in a session's baseline.
   * Used to reconcile changes made while the window was closed.
   */
  async listBaselineFiles(sessionId: string): Promise<string[]> {
    const dir = this.sessionDir(sessionId);
    const result: string[] = [];
    const walk = async (current: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(abs);
        } else if (entry.isFile()) {
          result.push(path.relative(dir, abs).split(path.sep).join("/"));
        }
      }
    };
    await walk(dir);
    return result;
  }

  /**
   * Snapshot the current workspace into this session's baseline folder.
   * Captured at session start so we have the original content of every file
   * that might later be modified or deleted. Ignored paths are skipped, as
   * are files larger than the configured limit (those become un-revertable).
   */
  async createBaseline(session: AgentSession): Promise<void> {
    const folder = getWorkspaceFolder();
    if (!folder) {
      throw new Error("No workspace folder open.");
    }
    const root = folder.uri.fsPath;
    const dest = this.sessionDir(session.id);
    await fsp.mkdir(dest, { recursive: true });
    await this.copyTree(root, root, dest, getIgnoredDirs(), getMaxSnapshotBytes());
  }

  /** Recursively copy a directory tree, skipping ignored paths. */
  private async copyTree(
    root: string,
    current: string,
    destRoot: string,
    ignoredDirs: Set<string>,
    maxBytes: number,
  ): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name) || isIgnored(rel)) {
          continue;
        }
        await this.copyTree(root, abs, destRoot, ignoredDirs, maxBytes);
      } else if (entry.isFile()) {
        if (isIgnored(rel)) {
          continue;
        }
        try {
          const stat = await fsp.stat(abs);
          if (stat.size > maxBytes) {
            continue;
          }
          const target = path.join(destRoot, ...rel.split("/"));
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await fsp.copyFile(abs, target);
        } catch {
          // Ignore unreadable files (permissions, symlinks, etc.).
        }
      }
    }
  }

  // ---- Checkpoint blobs ----------------------------------------------------
  // Content-addressed copies of files captured at checkpoint boundaries.
  // Deduplicated per session: a file unchanged across two checkpoints is
  // stored once.

  private blobPath(sessionId: string, hash: string): string {
    return path.join(this.blobRoot, sessionId, hash);
  }

  /** URI to a stored blob (used as a diff side). */
  blobUri(sessionId: string, hash: string): vscode.Uri {
    return vscode.Uri.file(this.blobPath(sessionId, hash));
  }

  hasBlob(sessionId: string, hash: string): boolean {
    return fs.existsSync(this.blobPath(sessionId, hash));
  }

  /** Read a blob's bytes, or undefined if missing. */
  async readBlob(
    sessionId: string,
    hash: string,
  ): Promise<Buffer | undefined> {
    try {
      return await fsp.readFile(this.blobPath(sessionId, hash));
    } catch {
      return undefined;
    }
  }

  /**
   * Store a workspace file's current content as a blob.
   * Returns the content hash, or undefined if the file is unreadable.
   */
  async storeBlob(
    sessionId: string,
    absPath: string,
  ): Promise<string | undefined> {
    const hash = await hashFile(absPath);
    if (!hash) {
      return undefined;
    }
    const target = this.blobPath(sessionId, hash);
    if (!fs.existsSync(target)) {
      try {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.copyFile(absPath, target);
      } catch {
        return undefined;
      }
    }
    return hash;
  }

  /** Remove all snapshot and blob data for a session. */
  async deleteSnapshot(sessionId: string): Promise<void> {
    await fsp.rm(this.sessionDir(sessionId), {
      recursive: true,
      force: true,
    });
    await fsp.rm(path.join(this.blobRoot, sessionId), {
      recursive: true,
      force: true,
    });
  }
}
