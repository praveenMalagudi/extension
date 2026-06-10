import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import ignore, { Ignore } from "ignore";

const CONFIG_SECTION = "agentChangeGuard";

const DEFAULT_IGNORED_DIRS = [
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "vendor",
];

/** Directory names that are never tracked or snapshotted (user-configurable). */
export function getIgnoredDirs(): Set<string> {
  const configured = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string[]>("ignoreDirectories", DEFAULT_IGNORED_DIRS);
  // .git is non-negotiable: reverting into it could corrupt the repo.
  return new Set([...configured, ".git"]);
}

/** Max bytes a file may have to be snapshotted (user-configurable, default 5 MB). */
export function getMaxSnapshotBytes(): number {
  const mb = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<number>("maxFileSizeMB", 5);
  return Math.max(1, mb) * 1024 * 1024;
}

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

// ---- Ignore matching -------------------------------------------------------

let gitignoreMatcher: Ignore | undefined;
let gitignoreMtime = -1;

/**
 * Matcher for the workspace root .gitignore, re-read when its mtime changes.
 * Nested .gitignore files are not consulted (acceptable for v0.1).
 */
function getGitignoreMatcher(): Ignore | undefined {
  if (
    !vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<boolean>("respectGitignore", true)
  ) {
    return undefined;
  }
  const folder = getWorkspaceFolder();
  if (!folder) {
    return undefined;
  }
  const gitignorePath = path.join(folder.uri.fsPath, ".gitignore");
  let mtime: number;
  try {
    mtime = fs.statSync(gitignorePath).mtimeMs;
  } catch {
    gitignoreMatcher = undefined;
    gitignoreMtime = -1;
    return undefined;
  }
  if (!gitignoreMatcher || mtime !== gitignoreMtime) {
    try {
      gitignoreMatcher = ignore().add(
        fs.readFileSync(gitignorePath, "utf8"),
      );
      gitignoreMtime = mtime;
    } catch {
      gitignoreMatcher = undefined;
    }
  }
  return gitignoreMatcher;
}

/** True if the path is in an ignored directory or matched by .gitignore. */
export function isIgnored(relPath: string): boolean {
  const ignoredDirs = getIgnoredDirs();
  if (relPath.split("/").some((segment) => ignoredDirs.has(segment))) {
    return true;
  }
  const matcher = getGitignoreMatcher();
  if (matcher) {
    try {
      return matcher.ignores(relPath);
    } catch {
      // Malformed path (e.g. absolute) — treat as not ignored.
    }
  }
  return false;
}

// ---- Content helpers -------------------------------------------------------

/** SHA-1 of a file's contents, or undefined if unreadable. */
export async function hashFile(absPath: string): Promise<string | undefined> {
  try {
    const data = await fsp.readFile(absPath);
    return createHash("sha1").update(data).digest("hex");
  } catch {
    return undefined;
  }
}

/** Heuristic: a NUL byte in the first 8 KB means the file is binary. */
export async function isProbablyBinary(absPath: string): Promise<boolean> {
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(absPath, "r");
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}
