import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";
import { AgentMessageSource } from "./types";
import { getWorkspaceFolder } from "./utils";

const POLL_MS = 2000;
const MAX_LABEL_LENGTH = 80;

/**
 * Watches the OpenAI Codex CLI's rollout transcripts for this workspace and
 * turns every user message into a checkpoint boundary on the active session.
 *
 * Unlike Claude Code (one directory per workspace), Codex writes one JSONL
 * "rollout" file per conversation under a date-partitioned tree:
 * `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl`. The first
 * line of each file is a `session_meta` entry whose `payload.cwd` records the
 * workspace, so we classify each file once and only tail the ones that belong
 * to this workspace.
 *
 * Genuine user prompts arrive as `event_msg` entries of type `user_message`
 * with the raw text in `payload.message` — this skips the `<environment_context>`
 * and developer/tool preamble that the lower-level `response_item` stream mixes in.
 */
export class CodexWatcher implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  /** Bytes already consumed per transcript file (keyed by absolute path). */
  private readonly offsets = new Map<string, number>();
  /** 1-based line number for the next complete JSONL line per transcript. */
  private readonly nextLineNumbers = new Map<string, number>();
  /** Partial trailing line per transcript file. */
  private readonly remainders = new Map<string, string>();
  /** Cached "does this file belong to our workspace?" decision per path. */
  private readonly ownership = new Map<string, boolean>();
  /** Cached Codex session/thread id per rollout transcript. */
  private readonly sessionIds = new Map<string, string>();
  private initialized = false;
  private busy = false;

  constructor(private readonly sessions: SessionManager) {
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  private sessionsRoot(): string {
    return path.join(os.homedir(), ".codex", "sessions");
  }

  /**
   * Date folders worth scanning: today and yesterday in local time. An active
   * session's rollout file lives under its start date, so this covers anything
   * currently running while bounding the work per poll.
   */
  private recentDirs(): string[] {
    const root = this.sessionsRoot();
    const dirs: string[] = [];
    const now = new Date();
    for (let back = 0; back <= 1; back++) {
      const d = new Date(now.getTime() - back * 24 * 60 * 60 * 1000);
      const yyyy = String(d.getFullYear());
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      dirs.push(path.join(root, yyyy, mm, dd));
    }
    return dirs;
  }

  private config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("agentChangeGuard.codex");
  }

  private async poll(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      await this.scan();
    } catch {
      // Never let transcript parsing break the extension.
    } finally {
      this.busy = false;
    }
  }

  private async scan(): Promise<void> {
    if (!this.config().get<boolean>("autoCheckpoint", true)) {
      return;
    }
    const workspace = getWorkspaceFolder();
    if (!workspace) {
      return;
    }
    const files: string[] = [];
    for (const dir of this.recentDirs()) {
      let entries: string[];
      try {
        entries = await fsp.readdir(dir);
      } catch {
        continue; // No sessions on this date.
      }
      for (const name of entries) {
        if (name.endsWith(".jsonl")) {
          files.push(path.join(dir, name));
        }
      }
    }

    // First scan: record current sizes without processing, so history from
    // before the extension loaded is not replayed as new messages.
    if (!this.initialized) {
      for (const file of files) {
        const size = await this.fileSize(file);
        this.offsets.set(file, size);
        this.nextLineNumbers.set(file, await this.nextLineNumber(file, size));
      }
      this.initialized = true;
      return;
    }

    const wsPath = normalizePath(workspace.uri.fsPath);
    for (const file of files) {
      if (!(await this.belongsToWorkspace(file, wsPath))) {
        continue;
      }
      const size = await this.fileSize(file);
      const offset = this.offsets.get(file) ?? 0;
      if (size <= offset) {
        if (size < offset) {
          this.offsets.set(file, size); // truncated/rotated
          this.nextLineNumbers.set(file, await this.nextLineNumber(file, size));
          this.remainders.delete(file);
        }
        continue;
      }
      const chunk = await this.readRange(file, offset, size);
      this.offsets.set(file, size);
      if (chunk === undefined) {
        continue;
      }
      const text = (this.remainders.get(file) ?? "") + chunk;
      const lines = text.split("\n");
      this.remainders.set(file, lines.pop() ?? "");
      let lineNumber = this.nextLineNumbers.get(file) ?? 1;
      for (const line of lines) {
        const prompt = extractUserPrompt(line);
        if (prompt) {
          await this.onUserPrompt(prompt, {
            agent: "codex",
            transcriptPath: file,
            sessionId: this.sessionIds.get(file) ?? codexSessionId(file),
            lineNumber,
          });
        }
        lineNumber++;
      }
      this.nextLineNumbers.set(file, lineNumber);
    }
  }

  /**
   * Decide (and cache) whether a rollout file belongs to this workspace by
   * reading the `cwd` from its `session_meta` header line.
   */
  private async belongsToWorkspace(
    file: string,
    wsPath: string,
  ): Promise<boolean> {
    const cached = this.ownership.get(file);
    if (cached !== undefined) {
      return cached;
    }
    const info = await this.readSessionInfo(file);
    // If the header is unreadable yet (file just created, partial write),
    // don't cache — retry on the next poll.
    if (info.cwd === undefined) {
      return false;
    }
    if (info.sessionId) {
      this.sessionIds.set(file, info.sessionId);
    }
    const owned = normalizePath(info.cwd) === wsPath;
    this.ownership.set(file, owned);
    return owned;
  }

  private async readSessionInfo(
    file: string,
  ): Promise<{ cwd?: string; sessionId?: string }> {
    const head = await this.readRange(file, 0, 65536);
    if (!head) {
      return {};
    }
    const firstLine = head.split("\n", 1)[0];
    if (!firstLine) {
      return {};
    }
    try {
      const entry = JSON.parse(firstLine);
      if (entry?.type === "session_meta") {
        const cwd = entry.payload?.cwd;
        const sessionId =
          stringValue(
            entry.payload?.id,
            entry.payload?.session_id,
            entry.payload?.sessionId,
            entry.payload?.conversation_id,
            entry.payload?.conversationId,
            entry.payload?.thread_id,
            entry.payload?.threadId,
          ) ?? codexSessionId(file);
        return {
          cwd: typeof cwd === "string" ? cwd : undefined,
          sessionId,
        };
      }
    } catch {
      // Header not yet fully written.
    }
    return { sessionId: codexSessionId(file) };
  }

  private async onUserPrompt(
    prompt: string,
    source: AgentMessageSource,
  ): Promise<void> {
    const label = truncate(prompt, MAX_LABEL_LENGTH);
    const session = this.sessions.getActiveSession();
    if (session) {
      await this.sessions.beginTurn(session, label, source);
      return;
    }
    if (this.config().get<boolean>("autoStartSession", true)) {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: "Agent Change Guard: snapshotting workspace…",
        },
        async () => {
          try {
            const started = await this.sessions.startSession(label, "codex");
            await this.sessions.beginTurn(started, label, source);
            vscode.window.showInformationMessage(
              `Agent Change Guard: tracking Codex session — "${label}"`,
            );
          } catch {
            // A session raced into existence; ignore.
          }
        },
      );
    }
  }

  private async nextLineNumber(file: string, size: number): Promise<number> {
    if (size === 0) {
      return 1;
    }
    const text = await this.readRange(file, 0, size);
    return countNewlines(text ?? "") + 1;
  }

  private async fileSize(file: string): Promise<number> {
    try {
      return (await fsp.stat(file)).size;
    } catch {
      return 0;
    }
  }

  private async readRange(
    file: string,
    start: number,
    end: number,
  ): Promise<string | undefined> {
    let handle: fsp.FileHandle | undefined;
    try {
      handle = await fsp.open(file, "r");
      const buf = Buffer.alloc(end - start);
      const { bytesRead } = await handle.read(buf, 0, buf.length, start);
      return buf.subarray(0, bytesRead).toString("utf8");
    } catch {
      return undefined;
    } finally {
      await handle?.close();
    }
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

/**
 * Extract the text of a genuine user prompt from one Codex rollout JSONL line.
 * Codex surfaces real prompts as `event_msg` entries of type `user_message`;
 * everything else (assistant output, tool calls, environment context,
 * developer preamble) is ignored.
 */
export function extractUserPrompt(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  let entry: any;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (entry?.type !== "event_msg") {
    return undefined;
  }
  const payload = entry.payload;
  if (!payload || payload.type !== "user_message") {
    return undefined;
  }
  const text =
    typeof payload.message === "string" ? payload.message.trim() : undefined;
  // Empty messages and harness bookkeeping (tag markup) are not prompts.
  if (!text || text.startsWith("<")) {
    return undefined;
  }
  return text;
}

function normalizePath(p: string): string {
  // macOS/Windows paths are case-insensitive; drop any trailing separator.
  return p.replace(/[\\/]+$/, "").toLowerCase();
}

function codexSessionId(file: string): string | undefined {
  const match = path
    .basename(file)
    .match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1];
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function countNewlines(text: string): number {
  return (text.match(/\n/g) ?? []).length;
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}
