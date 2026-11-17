import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";
import { AgentMessageSource } from "./types";
import { getWorkspaceFolder, promptLabel } from "./utils";

const POLL_MS = 2000;

/**
 * Watches Claude Code's transcript files for this workspace and turns every
 * user message into a checkpoint boundary on the active session.
 *
 * Claude Code writes one JSONL file per conversation under
 * `~/.claude/projects/<sanitized-workspace-path>/`. We tail those files:
 * whenever a new user prompt appears, the changes accumulated so far belong
 * to the *previous* turn, so they are folded into a checkpoint labelled with
 * that turn's message.
 *
 * Optionally (off by default) a session is auto-started on the first message
 * when none is active.
 */
export class ClaudeWatcher implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  /** Bytes already consumed per transcript file. */
  private readonly offsets = new Map<string, number>();
  /** 1-based line number for the next complete JSONL line per transcript. */
  private readonly nextLineNumbers = new Map<string, number>();
  /** Partial trailing line per transcript file. */
  private readonly remainders = new Map<string, string>();
  private initialized = false;
  private busy = false;

  constructor(private readonly sessions: SessionManager) {
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  /** `/Users/me/proj` -> `-Users-me-proj`, matching Claude Code's layout. */
  private transcriptDir(): string | undefined {
    const folder = getWorkspaceFolder();
    if (!folder) {
      return undefined;
    }
    const sanitized = folder.uri.fsPath.replace(/[^a-zA-Z0-9]/g, "-");
    return path.join(os.homedir(), ".claude", "projects", sanitized);
  }

  private config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("agentChangeGuard.claudeCode");
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
    const dir = this.transcriptDir();
    if (!dir) {
      return;
    }
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch (err) {
      // Claude Code not used in this workspace yet. There is no history to
      // skip, so the first transcript it creates is read from the start —
      // otherwise the first message of the first conversation would be lost.
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.initialized = true;
      }
      return;
    }
    const transcripts = entries.filter((e) => e.endsWith(".jsonl"));

    // First scan: record current sizes without processing, so history from
    // before the extension loaded is not replayed as new messages.
    if (!this.initialized) {
      for (const name of transcripts) {
        const file = path.join(dir, name);
        const size = await this.fileSize(file);
        this.offsets.set(name, size);
        this.nextLineNumbers.set(name, await this.nextLineNumber(file, size));
      }
      this.initialized = true;
      return;
    }

    for (const name of transcripts) {
      const file = path.join(dir, name);
      const size = await this.fileSize(file);
      const offset = this.offsets.get(name) ?? 0;
      if (size <= offset) {
        if (size < offset) {
          this.offsets.set(name, size); // truncated/rotated
          this.nextLineNumbers.set(name, await this.nextLineNumber(file, size));
          this.remainders.delete(name);
        }
        continue;
      }
      const chunk = await this.readRange(file, offset, size);
      this.offsets.set(name, size);
      if (chunk === undefined) {
        continue;
      }
      const text = (this.remainders.get(name) ?? "") + chunk;
      const lines = text.split("\n");
      this.remainders.set(name, lines.pop() ?? "");
      let lineNumber = this.nextLineNumbers.get(name) ?? 1;
      for (const line of lines) {
        const prompt = extractUserPrompt(line);
        if (prompt) {
          await this.onUserPrompt(prompt, {
            agent: "claude",
            transcriptPath: file,
            sessionId: claudeSessionId(name),
            lineNumber,
          });
        }
        lineNumber++;
      }
      this.nextLineNumbers.set(name, lineNumber);
    }
  }

  private async onUserPrompt(
    prompt: string,
    source: AgentMessageSource,
  ): Promise<void> {
    const label = promptLabel(prompt);
    const session = this.sessions.getActiveSession();
    if (session) {
      await this.sessions.beginTurn(session, label, source);
      return;
    }
    if (this.config().get<boolean>("autoStartSession", false)) {
      try {
        const started = await this.sessions.startSession(label, "claude");
        await this.sessions.beginTurn(started, label, source);
        vscode.window.showInformationMessage(
          `Agent Change Guard: started session for Claude Code — "${label}"`,
        );
      } catch {
        // A session raced into existence; ignore.
      }
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

function claudeSessionId(fileName: string): string | undefined {
  const parsed = path.parse(fileName);
  return parsed.ext === ".jsonl" && parsed.name ? parsed.name : undefined;
}

function countNewlines(text: string): number {
  return (text.match(/\n/g) ?? []).length;
}

/**
 * Extract the text of a genuine user prompt from one transcript JSONL line.
 * Returns undefined for assistant turns, tool results, meta entries, and
 * slash-command bookkeeping.
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
  if (entry?.type !== "user" || entry.isMeta) {
    return undefined;
  }
  const message = entry.message;
  if (!message || message.role !== "user") {
    return undefined;
  }
  let text: string | undefined;
  if (typeof message.content === "string") {
    text = message.content;
  } else if (Array.isArray(message.content)) {
    // Tool results arrive as user-role entries; those are not prompts.
    if (message.content.some((c: any) => c?.type === "tool_result")) {
      return undefined;
    }
    text = message.content
      .filter((c: any) => c?.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join(" ");
  }
  if (!text) {
    return undefined;
  }
  text = text.trim();
  // Slash commands and harness bookkeeping start with tag markup.
  if (!text || text.startsWith("<")) {
    return undefined;
  }
  return text;
}
