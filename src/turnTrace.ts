import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as readline from "readline";
import { extractUserPrompt as extractClaudePrompt } from "./claudeWatcher";
import {
  extractUserPrompt as extractCodexPrompt,
  mightBeUserPrompt as mightBeCodexPrompt,
} from "./codexWatcher";
import {
  AgentMessageSource,
  ChangeStatus,
  StepFile,
  StepKind,
  StepStatus,
  TurnStep,
  TurnTrace,
} from "./types";
import { getWorkspaceFolder, promptLabel, toRelativePath } from "./utils";

/** Stop reading a turn after this many transcript lines. */
const MAX_TURN_LINES = 50_000;
/** Steps kept per turn (and per subagent). */
const MAX_STEPS = 2_000;
const MAX_TITLE_CHARS = 160;
const MAX_DETAIL_CHARS = 2_000;
/** Subagents launched by subagents are followed this deep. */
const MAX_SUBAGENT_DEPTH = 2;
const CACHE_LIMIT = 100;

/** Claude Code's wording when the user (or a permission rule) declines a tool. */
const REJECTED_RE =
  /doesn't want to proceed|tool use was rejected|permission to use .+ (?:has been )?denied/i;
/** A file header line of a Codex `*** Begin Patch` body. */
const PATCH_HEADER_RE = /^\*\*\* (?:Add|Update|Delete) File: /m;

/**
 * Turn traces: what the agent did during one turn, reconstructed from its
 * transcript. A checkpoint already stores the transcript path and the line
 * of the user message that started the turn, so a trace is everything from
 * that line up to the next user message. Nothing is persisted; traces are
 * read on demand and cached here.
 */
export class TurnTraces {
  private readonly cache = new Map<
    string,
    { closed: boolean; size: number; trace: TurnTrace | undefined }
  >();
  private readonly inflight = new Map<string, Promise<TurnTrace | undefined>>();

  /**
   * Trace for the turn that `source` started. A closed turn (one folded into
   * a checkpoint) never changes, so it is read once; the in-progress turn is
   * re-read whenever its transcript grows. `label` is the turn's label, used
   * to find its message if the transcript was rewritten (see readTurnTrace).
   */
  async get(
    source: AgentMessageSource,
    closed: boolean,
    label?: string,
  ): Promise<TurnTrace | undefined> {
    const key = `${source.transcriptPath}:${source.lineNumber}:${label ?? ""}`;
    const size = closed ? -1 : await fileSize(source.transcriptPath);
    const hit = this.cache.get(key);
    if (hit && (closed ? hit.closed : !hit.closed && hit.size === size)) {
      // Re-insert to keep the most recently used entries at the end.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit.trace;
    }
    const flightKey = `${key}:${size}`;
    const running = this.inflight.get(flightKey);
    if (running) {
      return running;
    }
    const load = readTurnTrace(source, label)
      .catch(() => undefined)
      .then((trace) => {
        this.cache.delete(key);
        this.cache.set(key, { closed, size, trace });
        while (this.cache.size > CACHE_LIMIT) {
          this.cache.delete(this.cache.keys().next().value!);
        }
        return trace;
      })
      .finally(() => this.inflight.delete(flightKey));
    this.inflight.set(flightKey, load);
    return load;
  }
}

/**
 * Read the steps of the turn that starts at `source.lineNumber`. Returns
 * undefined when the transcript is gone or the turn's message can no longer
 * be found in it.
 *
 * `label` is the label the watcher gave the turn (promptLabel of its
 * message). When given, the message at the recorded line must match it;
 * otherwise the transcript was rewritten since — Codex migrates old rollouts
 * to newer formats, which shifts every line — and the message is looked up
 * by its label instead.
 */
export async function readTurnTrace(
  source: AgentMessageSource,
  label?: string,
): Promise<TurnTrace | undefined> {
  const recorded = source.lineNumber;
  if (recorded === undefined || recorded < 1) {
    return undefined;
  }
  try {
    await fsp.access(source.transcriptPath);
  } catch {
    return undefined;
  }
  const format = promptFormat(source.agent);
  const trace = await readTurnFrom(source, recorded, format);
  if (
    label === undefined ||
    (trace?.prompt !== undefined && promptLabel(trace.prompt) === label)
  ) {
    return trace;
  }
  const moved = await findPrompt(source.transcriptPath, label, recorded, format);
  if (moved !== undefined && moved !== recorded) {
    return readTurnFrom(source, moved, format);
  }
  // No message has that label (e.g. a checkpoint the user named by hand):
  // keep the recorded line, as long as it still starts a turn.
  return trace;
}

/** How a transcript marks the user messages that start turns. */
interface PromptFormat {
  /** Cheap substring test; false means the line is certainly not a prompt. */
  mightBe(line: string): boolean;
  extract(line: string): string | undefined;
}

function promptFormat(agent: AgentMessageSource["agent"]): PromptFormat {
  return agent === "claude"
    ? { mightBe: (line) => line.includes('"user"'), extract: extractClaudePrompt }
    : { mightBe: mightBeCodexPrompt, extract: extractCodexPrompt };
}

/** The line of the message labelled `label` nearest to line `near`. */
async function findPrompt(
  file: string,
  label: string,
  near: number,
  format: PromptFormat,
): Promise<number | undefined> {
  let best: number | undefined;
  await forEachLine(file, 1, (line, lineNumber) => {
    if (format.mightBe(line)) {
      const prompt = format.extract(line);
      if (
        prompt !== undefined &&
        promptLabel(prompt) === label &&
        (best === undefined ||
          Math.abs(lineNumber - near) < Math.abs(best - near))
      ) {
        best = lineNumber;
      }
    }
    // Past `near`, lines only get farther away than the best match.
    return best === undefined || lineNumber - near < Math.abs(best - near);
  });
  return best;
}

/** Read the turn whose user message is on line `start`. */
async function readTurnFrom(
  source: AgentMessageSource,
  start: number,
  format: PromptFormat,
): Promise<TurnTrace | undefined> {
  const parser: TraceParser =
    source.agent === "claude"
      ? new ClaudeParser(subagentDir(source.transcriptPath), 0)
      : new CodexParser();

  let prompt: string | undefined;
  let startedAt: number | undefined;
  let truncated = false;
  await forEachLine(source.transcriptPath, start, (line, lineNumber) => {
    if (lineNumber === start) {
      prompt = format.extract(line);
      startedAt = parseTime(parseJson(line)?.timestamp);
      return prompt !== undefined;
    }
    if (format.mightBe(line) && format.extract(line) !== undefined) {
      return false; // The next turn starts here.
    }
    if (lineNumber - start > MAX_TURN_LINES || parser.steps.length >= MAX_STEPS) {
      truncated = true;
      return false;
    }
    parser.consume(line);
    return true;
  });
  if (prompt === undefined) {
    return undefined;
  }
  await parser.finish();
  return {
    agent: source.agent,
    prompt,
    startedAt,
    endedAt: parser.lastTimestamp ?? startedAt,
    steps: parser.steps,
    truncated,
  };
}

// ---- Attribution -------------------------------------------------------------

/** Path comparison key: macOS and Windows file systems ignore case. */
export function pathKey(p: string): string {
  return process.platform === "darwin" || process.platform === "win32"
    ? p.toLowerCase()
    : p;
}

/** Visit every step, including subagent steps, depth-first in order. */
export function walkSteps(
  steps: TurnStep[],
  visit: (step: TurnStep) => void,
): void {
  for (const step of steps) {
    visit(step);
    if (step.children) {
      walkSteps(step.children, visit);
    }
  }
}

/** Steps that wrote each workspace path, keyed by pathKey. */
export function collectWriters(steps: TurnStep[]): Map<string, TurnStep[]> {
  const writers = new Map<string, TurnStep[]>();
  walkSteps(steps, (step) => {
    // A declined or failed edit did not write anything.
    if (step.status === "rejected") {
      return;
    }
    for (const file of step.files) {
      if (file.access === "write" && file.inWorkspace) {
        const key = pathKey(file.path);
        writers.set(key, [...(writers.get(key) ?? []), step]);
      }
    }
  });
  return writers;
}

/**
 * Paths a closed turn changed although no recorded agent step wrote them —
 * typically a shell command, a formatter, a build step, or the user. Empty
 * when the trace is incomplete, since a missing writer proves nothing then.
 */
export function unexplainedChanges(
  files: { path: string }[],
  trace: TurnTrace,
): Set<string> {
  const result = new Set<string>();
  if (trace.truncated) {
    return result;
  }
  const writers = collectWriters(trace.steps);
  for (const file of files) {
    if (!writers.has(pathKey(file.path))) {
      result.add(file.path);
    }
  }
  return result;
}

// ---- Parsers -----------------------------------------------------------------

interface TraceParser {
  readonly steps: TurnStep[];
  readonly lastTimestamp: number | undefined;
  consume(line: string): void;
  /** Load anything that lives outside the turn's lines (subagents). */
  finish(): Promise<void>;
}

/**
 * Claude Code transcript entries. Tool calls are `tool_use` blocks in
 * assistant entries; their outcomes are `tool_result` blocks in the next user
 * entry, whose `toolUseResult` carries structured details (patches, files a
 * Bash command edited, the id of a launched subagent).
 */
class ClaudeParser implements TraceParser {
  readonly steps: TurnStep[] = [];
  lastTimestamp: number | undefined;
  private readonly byId = new Map<string, TurnStep>();
  private readonly subagents: { step: TurnStep; agentId: string }[] = [];

  /** `dir` holds subagent transcripts: `<session>/subagents/agent-<id>.jsonl`. */
  constructor(
    private readonly dir: string,
    private readonly depth: number,
  ) {}

  consume(line: string): void {
    if (
      !line.includes('"tool_use"') &&
      !line.includes('"tool_result"') &&
      !line.includes('"assistant"')
    ) {
      return;
    }
    const entry = parseJson(line);
    const content = entry?.message?.content;
    if (!Array.isArray(content)) {
      return;
    }
    const timestamp = parseTime(entry.timestamp);
    if (entry.type === "assistant") {
      this.lastTimestamp = timestamp ?? this.lastTimestamp;
      content.forEach((block: any, i: number) => {
        if (block?.type === "tool_use" && typeof block.id === "string") {
          this.add(claudeToolStep(block, timestamp));
        } else if (block?.type === "text" && this.depth === 0) {
          const step = messageStep(`${entry.uuid ?? ""}:${i}`, block.text, timestamp);
          if (step) {
            this.add(step);
          }
        }
      });
      return;
    }
    if (entry.type !== "user") {
      return;
    }
    const results = content.filter((b: any) => b?.type === "tool_result");
    if (results.length > 0) {
      this.lastTimestamp = timestamp ?? this.lastTimestamp;
    }
    for (const block of results) {
      const step = this.byId.get(block.tool_use_id);
      if (step) {
        // toolUseResult describes the entry's single result.
        this.applyResult(
          step,
          block,
          results.length === 1 ? entry.toolUseResult : undefined,
        );
      }
    }
  }

  async finish(): Promise<void> {
    if (this.depth >= MAX_SUBAGENT_DEPTH) {
      return;
    }
    for (const { step, agentId } of this.subagents) {
      const file = path.join(this.dir, `agent-${agentId}.jsonl`);
      const parser = new ClaudeParser(this.dir, this.depth + 1);
      try {
        await forEachLine(file, 1, (line) => {
          parser.consume(line);
          return parser.steps.length < MAX_STEPS;
        });
      } catch {
        continue; // Transcript not written (yet) or removed.
      }
      await parser.finish();
      if (parser.steps.length > 0) {
        step.children = parser.steps;
      }
    }
  }

  private add(step: TurnStep): void {
    if (this.byId.has(step.id)) {
      return; // Claude Code can log the same block twice.
    }
    this.byId.set(step.id, step);
    this.steps.push(step);
  }

  private applyResult(step: TurnStep, block: any, result: any): void {
    if (isObject(result) && result.interrupted === true) {
      step.status = "interrupted";
    } else if (block.is_error === true) {
      step.status = REJECTED_RE.test(resultText(block.content))
        ? "rejected"
        : "error";
    } else {
      step.status = "ok";
    }
    if (!isObject(result)) {
      return;
    }
    if (Array.isArray(result.structuredPatch) && result.structuredPatch.length > 0) {
      // The applied patch replaces any estimate made from the tool input.
      step.added = 0;
      step.removed = 0;
      addHunkCounts(step, result.structuredPatch);
    }
    if (step.kind === "write" && (result.type === "create" || result.type === "update")) {
      const change: ChangeStatus = result.type === "create" ? "created" : "modified";
      step.files.forEach((f) => (f.change = change));
    }
    if (result.userModified === true) {
      step.userModified = true;
    }
    // Files a Bash command changed, as detected by Claude Code itself.
    const bashDiff = result.bashEditDiff;
    if (isObject(bashDiff)) {
      const paths = new Set<string>();
      for (const f of asArray(bashDiff.files)) {
        const p = str(f?.filePath);
        if (p) {
          paths.add(p);
        }
        addHunkCounts(step, asArray(f?.hunks));
      }
      for (const p of asArray(bashDiff.changedFiles)) {
        if (typeof p === "string" && p) {
          paths.add(p);
        }
      }
      for (const p of paths) {
        addFile(step, stepFile(p, "write"));
      }
    }
    if (step.kind === "agent" && typeof result.agentId === "string") {
      this.subagents.push({ step, agentId: result.agentId });
    }
  }
}

function claudeToolStep(block: any, timestamp: number | undefined): TurnStep {
  const name = str(block.name) ?? "tool";
  const input = isObject(block.input) ? block.input : {};
  const step = baseStep(block.id, name, timestamp);
  const file =
    str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  switch (name) {
    case "Read":
    case "NotebookRead":
      return fileStep(step, "read", file);
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return fileStep(step, "edit", file);
    case "Write": {
      // A new file has no patch in its result; count the written lines.
      const content = typeof input.content === "string" ? input.content : undefined;
      if (content !== undefined) {
        step.added = content ? content.replace(/\n$/, "").split("\n").length : 0;
        step.removed = 0;
      }
      return fileStep(step, "write", file);
    }
    case "Grep":
    case "Glob":
    case "LS": {
      step.kind = "search";
      const pattern = str(input.pattern);
      const where = str(input.path);
      step.title = clip(
        pattern
          ? where
            ? `${pattern} in ${displayPath(where)}`
            : pattern
          : where
            ? displayPath(where)
            : name,
      );
      return step;
    }
    case "Bash":
    case "bash":
    case "PowerShell":
      return commandStep(step, str(input.command), str(input.description));
    case "Agent":
    case "Task":
      step.kind = "agent";
      step.title = clip(str(input.description) ?? "Subagent");
      step.note = str(input.subagent_type);
      step.detail = clipDetail(str(input.prompt));
      return step;
    case "WebFetch":
      step.kind = "web";
      step.title = clip(str(input.url) ?? name);
      return step;
    case "WebSearch":
      step.kind = "web";
      step.title = clip(str(input.query) ?? name);
      return step;
    default:
      step.note = str(input.description);
      return step;
  }
}

/**
 * Codex rollout entries. Tool calls are `response_item` payloads of type
 * `function_call` / `custom_tool_call` (`apply_patch` edits files), matched to
 * their `*_output` payloads by `call_id`. Codex also records each patch it
 * applied as an `event_msg` / `item_completed` item of type `FileChange`.
 */
class CodexParser implements TraceParser {
  readonly steps: TurnStep[] = [];
  lastTimestamp: number | undefined;
  private readonly byId = new Map<string, TurnStep>();

  consume(line: string): void {
    const fileChange = line.includes('"FileChange"');
    if (!fileChange && !line.includes('"response_item"')) {
      return;
    }
    const entry = parseJson(line);
    const p = entry?.payload;
    if (!isObject(p)) {
      return;
    }
    const timestamp = parseTime(entry.timestamp);
    if (entry.type === "event_msg") {
      if (fileChange && p.type === "item_completed" && p.item?.type === "FileChange") {
        this.lastTimestamp = timestamp ?? this.lastTimestamp;
        this.applyFileChange(p.item, timestamp);
      }
      return;
    }
    if (entry.type !== "response_item") {
      return;
    }
    this.lastTimestamp = timestamp ?? this.lastTimestamp;
    const id = str(p.call_id) ?? str(p.id) ?? `codex:${this.steps.length}`;
    switch (p.type) {
      case "function_call":
        this.add(codexFunctionStep(id, p, timestamp));
        return;
      case "custom_tool_call": {
        const step = baseStep(id, str(p.name) ?? "tool", timestamp);
        const input = str(p.input) ?? "";
        this.add(
          step.tool === "apply_patch"
            ? patchStep(step, input)
            : codexCommandStep(step, input, undefined),
        );
        return;
      }
      case "local_shell_call": {
        const step = baseStep(id, "local_shell", timestamp);
        this.add(codexCommandStep(step, shellText(p.action?.command), undefined));
        return;
      }
      case "web_search_call": {
        const step = baseStep(id, "web_search", timestamp);
        step.kind = "web";
        step.title = clip(str(p.action?.query) ?? "Web search");
        step.status = p.status === "failed" ? "error" : "ok";
        this.add(step);
        return;
      }
      case "function_call_output":
      case "custom_tool_call_output":
      case "local_shell_call_output": {
        const step = this.byId.get(id);
        // A patch the user declined stays declined whatever the output says.
        if (step && step.status !== "rejected") {
          step.status = codexOutputStatus(outputText(p.output));
        }
        return;
      }
      case "message": {
        if (p.role !== "assistant") {
          return;
        }
        const text = asArray(p.content)
          .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
          .join("\n");
        const step = messageStep(id, text, timestamp);
        if (step) {
          this.add(step);
        }
        return;
      }
    }
  }

  async finish(): Promise<void> {
    // Codex keeps everything in one rollout file.
  }

  private add(step: TurnStep): void {
    if (this.byId.has(step.id)) {
      return;
    }
    this.byId.set(step.id, step);
    this.steps.push(step);
  }

  /**
   * Codex's record of the files a patch changed, with the applied diffs; it
   * replaces what was parsed from the patch text. A patch applied by the
   * `apply_patch` tool carries that call's id. One applied from inside an
   * `exec` script carries an id of its own ("exec-…") and arrives while the
   * script is still running, so it belongs to the running step.
   */
  private applyFileChange(item: any, timestamp: number | undefined): void {
    if (!isObject(item.changes)) {
      return;
    }
    const id = str(item.id);
    const own = id === undefined ? undefined : this.byId.get(id);
    if (own && (item.status === "declined" || item.status === "failed")) {
      own.status = item.status === "declined" ? "rejected" : "error";
      return; // Nothing was written.
    }
    if (item.status !== "completed") {
      return;
    }
    let step = own ?? this.runningStep();
    if (!step) {
      step = baseStep(id ?? `codex:${this.steps.length}`, "apply_patch", timestamp);
      step.status = "ok";
      this.add(step);
    }
    if (own) {
      // Codex's list is complete; drop the files guessed from the patch text.
      step.files = step.files.filter((f) => f.access !== "write");
      step.added = undefined;
      step.removed = undefined;
    }
    for (const [file, change] of Object.entries(item.changes)) {
      const c: any = change;
      const status: ChangeStatus =
        c?.type === "add" ? "created" : c?.type === "delete" ? "deleted" : "modified";
      const moveTo = str(c?.move_path);
      addFile(step, stepFile(file, "write", moveTo ? "deleted" : status));
      if (moveTo) {
        addFile(step, stepFile(moveTo, "write", "created"));
      }
      if (typeof c?.unified_diff === "string") {
        addHunkCounts(step, [{ lines: c.unified_diff.split("\n") }]);
      } else if (typeof c?.content === "string") {
        // Added and deleted files come with their whole content instead.
        const lines = c.content ? c.content.replace(/\n$/, "").split("\n").length : 0;
        if (status === "deleted") {
          step.removed = (step.removed ?? 0) + lines;
          step.added ??= 0;
        } else {
          step.added = (step.added ?? 0) + lines;
          step.removed ??= 0;
        }
      }
    }
    describePatch(step);
  }

  /** The latest step still waiting for its output. */
  private runningStep(): TurnStep | undefined {
    for (let i = this.steps.length - 1; i >= 0; i--) {
      const step = this.steps[i];
      if (step.status === "running" && step.kind !== "message") {
        return step;
      }
    }
    return undefined;
  }
}

function codexFunctionStep(
  id: string,
  p: any,
  timestamp: number | undefined,
): TurnStep {
  const name = str(p.name) ?? "tool";
  const args = parseArguments(p.arguments);
  const step = baseStep(id, name, timestamp);
  switch (name) {
    case "exec_command":
    case "shell":
    case "container.exec":
    case "local_shell":
      return codexCommandStep(
        step,
        shellText(args.cmd ?? args.command),
        str(args.justification),
      );
    case "apply_patch":
      return patchStep(step, str(args.input) ?? str(args.patch) ?? "");
    case "js":
      return commandStep(step, str(args.code), str(args.title));
    case "view_image":
      return fileStep(step, "read", str(args.path));
    case "update_plan":
      step.title = "Updated the plan";
      step.note = str(args.explanation);
      return step;
    case "write_stdin":
      step.title = "Sent input to a running command";
      return step;
    case "spawn_agent":
      step.kind = "agent";
      step.title = clip(firstLine(str(args.message) ?? str(args.prompt)) ?? "Subagent");
      step.detail = clipDetail(str(args.message) ?? str(args.prompt));
      return step;
    default:
      step.title = prettyToolName(name.replace(/^_+/, ""));
      return step;
  }
}

/**
 * Codex sometimes applies patches through the shell (`apply_patch <<EOF`).
 * A script that merely contains a patch as a string literal (escaped
 * newlines, so no header lines) stays a command; the FileChange records
 * name the files it changed.
 */
function codexCommandStep(
  step: TurnStep,
  command: string | undefined,
  note: string | undefined,
): TurnStep {
  if (command && PATCH_HEADER_RE.test(command)) {
    return patchStep(step, command);
  }
  return commandStep(step, command, note);
}

/** Parse the files and line counts out of a Codex `*** Begin Patch` body. */
function patchStep(step: TurnStep, patch: string): TurnStep {
  let current: StepFile | undefined;
  let added = 0;
  let removed = 0;
  for (const raw of patch.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const header = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    const move = line.match(/^\*\*\* Move to: (.+)$/);
    if (header) {
      const change: ChangeStatus =
        header[1] === "Add" ? "created" : header[1] === "Delete" ? "deleted" : "modified";
      current = stepFile(header[2].trim(), "write", change);
      addFile(step, current);
    } else if (move && current) {
      current.change = "deleted";
      current = stepFile(move[1].trim(), "write", "created");
      addFile(step, current);
    } else if (line.startsWith("***")) {
      continue;
    } else if (line.startsWith("+")) {
      added++;
    } else if (line.startsWith("-")) {
      removed++;
    }
  }
  describePatch(step);
  step.added = added;
  step.removed = removed;
  return step;
}

/** Kind and title of a step that applied a patch, from the files it wrote. */
function describePatch(step: TurnStep): void {
  const writes = step.files.filter((f) => f.access === "write");
  const changes = writes.map((f) => f.change);
  step.kind =
    changes.length > 0 && changes.every((c) => c === "created")
      ? "write"
      : changes.length > 0 && changes.every((c) => c === "deleted")
        ? "delete"
        : "edit";
  step.title =
    writes.length === 1
      ? writes[0].path
      : writes.length > 1
        ? `${writes.length} files`
        : step.tool;
}

function codexOutputStatus(text: string): StepStatus {
  if (text.startsWith("{")) {
    const json = parseJson(text);
    const code = json?.metadata?.exit_code;
    if (typeof code === "number") {
      return code === 0 ? "ok" : "error";
    }
  }
  const match = text
    .slice(0, 4000)
    .match(/(?:Process exited with code|Exit code:?)\s+(-?\d+)/);
  if (match) {
    return Number(match[1]) === 0 ? "ok" : "error";
  }
  return /\b(?:rejected|declined) by (?:the )?user\b/i.test(text.slice(0, 500))
    ? "rejected"
    : "ok";
}

// ---- Step builders -----------------------------------------------------------

function baseStep(
  id: string,
  tool: string,
  timestamp: number | undefined,
): TurnStep {
  return {
    id,
    kind: "other",
    tool,
    title: prettyToolName(tool),
    ...(timestamp !== undefined ? { timestamp } : {}),
    status: "running",
    files: [],
  };
}

function fileStep(
  step: TurnStep,
  kind: Extract<StepKind, "read" | "edit" | "write">,
  file: string | undefined,
): TurnStep {
  step.kind = kind;
  if (file) {
    const f = stepFile(
      file,
      kind === "read" ? "read" : "write",
      kind === "edit" ? "modified" : undefined,
    );
    addFile(step, f);
    step.title = clip(f.path);
  }
  return step;
}

function commandStep(
  step: TurnStep,
  command: string | undefined,
  note: string | undefined,
): TurnStep {
  step.kind = "command";
  if (command) {
    step.title = clip(firstLine(command) ?? command);
    if (command.trim() !== step.title) {
      step.detail = clipDetail(command);
    }
  }
  if (note) {
    step.note = clip(note);
  }
  return step;
}

function messageStep(
  id: string,
  text: unknown,
  timestamp: number | undefined,
): TurnStep | undefined {
  if (typeof text !== "string" || !text.trim()) {
    return undefined;
  }
  return {
    id,
    kind: "message",
    tool: "message",
    title: clip(firstLine(text) ?? text),
    detail: clipDetail(text.trim()),
    ...(timestamp !== undefined ? { timestamp } : {}),
    status: "ok",
    files: [],
  };
}

function addFile(step: TurnStep, file: StepFile): void {
  const existing = step.files.find(
    (f) => f.access === file.access && pathKey(f.path) === pathKey(file.path),
  );
  if (existing) {
    existing.change ??= file.change;
  } else {
    step.files.push(file);
  }
}

/** Resolve an agent-reported path against the workspace. */
function stepFile(
  p: string,
  access: StepFile["access"],
  change?: ChangeStatus,
): StepFile {
  const root = getWorkspaceFolder()?.uri.fsPath;
  const abs = path.isAbsolute(p) || !root ? p : path.resolve(root, p);
  const rel = toRelativePath(abs) ?? relativeIgnoringCase(root, abs);
  return {
    path: rel || abs,
    inWorkspace: !!rel,
    access,
    ...(change ? { change } : {}),
  };
}

/**
 * macOS and Windows file systems ignore case, so an agent can log
 * `…/FE-flowy/src/a.ts` in a workspace opened as `…/fe-flowy`: same file.
 */
function relativeIgnoringCase(
  root: string | undefined,
  abs: string,
): string | undefined {
  if (!root || (process.platform !== "darwin" && process.platform !== "win32")) {
    return undefined;
  }
  const prefix = root.replace(/[\\/]+$/, "") + path.sep;
  if (!abs.toLowerCase().startsWith(prefix.toLowerCase())) {
    return undefined;
  }
  return abs.slice(prefix.length).split(path.sep).join("/") || undefined;
}

/** Count +/- lines of structured-patch hunks onto a step. */
function addHunkCounts(step: TurnStep, hunks: unknown[]): void {
  for (const hunk of hunks) {
    for (const line of asArray((hunk as any)?.lines)) {
      if (typeof line !== "string") {
        continue;
      }
      if (line.startsWith("+")) {
        step.added = (step.added ?? 0) + 1;
      } else if (line.startsWith("-")) {
        step.removed = (step.removed ?? 0) + 1;
      }
    }
  }
}

// ---- Small helpers -----------------------------------------------------------

/**
 * Call `visit` for each line from 1-based `fromLine` until it returns false.
 * Lines are numbered the same way the transcript watchers number them.
 */
async function forEachLine(
  file: string,
  fromLine: number,
  visit: (line: string, lineNumber: number) => boolean,
): Promise<void> {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let failure: Error | undefined;
  stream.on("error", (err) => {
    failure = err;
    lines.close();
  });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber++;
      if (lineNumber >= fromLine && !visit(line, lineNumber)) {
        break;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  if (failure) {
    throw failure;
  }
}

/** `<dir>/<id>.jsonl` → `<dir>/<id>/subagents`, where Claude Code puts them. */
function subagentDir(transcriptPath: string): string {
  const parsed = path.parse(transcriptPath);
  return parsed.dir.endsWith(`${path.sep}subagents`)
    ? parsed.dir
    : path.join(parsed.dir, parsed.name, "subagents");
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return 0;
  }
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseArguments(value: unknown): Record<string, any> {
  if (isObject(value)) {
    return value;
  }
  const parsed = typeof value === "string" ? parseJson(value) : undefined;
  return isObject(parsed) ? parsed : {};
}

function parseTime(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

/** `["bash", "-lc", "npm test"]` → `npm test`. */
function shellText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    return undefined;
  }
  if (value.length === 3 && /^-l?c$/.test(value[1])) {
    return value[2];
  }
  return value.join(" ");
}

function resultText(content: unknown): string {
  if (typeof content === "string") {
    return content.slice(0, 1000);
  }
  return asArray(content)
    .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
    .join(" ")
    .slice(0, 1000);
}

function outputText(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  if (Array.isArray(output)) {
    return output
      .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
      .join("\n");
  }
  return output === undefined ? "" : JSON.stringify(output);
}

/** `mcp__server__tool` → `server › tool`. */
function prettyToolName(name: string): string {
  return name.replace(/^mcp__/, "").split("__").join(" › ");
}

function displayPath(p: string): string {
  return stepFile(p, "read").path;
}

function firstLine(text: string | undefined): string | undefined {
  const line = text?.trim().split("\n", 1)[0]?.trim();
  return line || undefined;
}

function clip(text: string, max = MAX_TITLE_CHARS): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function clipDetail(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  return text.length <= MAX_DETAIL_CHARS
    ? text
    : `${text.slice(0, MAX_DETAIL_CHARS - 1)}…`;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
