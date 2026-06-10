import * as path from "path";
import { randomUUID } from "crypto";
import * as vscode from "vscode";

/** Folders that are never tracked or snapshotted. */
export const IGNORED_DIRS = new Set<string>([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  "coverage",
]);

/** Skip snapshotting very large files to keep storage reasonable (5 MB). */
export const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

/** Generate a unique session id. */
export function generateId(): string {
  return randomUUID();
}

/** First workspace folder, or undefined if none is open. */
export function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

/**
 * Convert an absolute fs path to a workspace-relative POSIX path.
 * Returns undefined if the path is outside the workspace.
 */
export function toRelativePath(absPath: string): string | undefined {
  const folder = getWorkspaceFolder();
  if (!folder) {
    return undefined;
  }
  const root = folder.uri.fsPath;
  const rel = path.relative(root, absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return undefined;
  }
  return rel.split(path.sep).join("/");
}

/** Resolve a workspace-relative path back to an absolute fs path. */
export function toAbsolutePath(relPath: string): string | undefined {
  const folder = getWorkspaceFolder();
  if (!folder) {
    return undefined;
  }
  return path.join(folder.uri.fsPath, ...relPath.split("/"));
}

/** True if any path segment is an ignored folder. */
export function isIgnored(relPath: string): boolean {
  return relPath.split("/").some((segment) => IGNORED_DIRS.has(segment));
}
