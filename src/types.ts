// Shared types for Agent Change Guard.

/** Which agent produced the changes. "manual" = user-driven session. */
export type AgentType = "manual" | "claude" | "codex" | "cursor";

/** How a file changed relative to its baseline snapshot. */
export type ChangeStatus = "created" | "modified" | "deleted";

/** Lifecycle status of a session. */
export type SessionStatus = "active" | "ended" | "accepted" | "reverted";

export interface AgentChangedFile {
  /** Workspace-relative path (POSIX separators). */
  path: string;
  status: ChangeStatus;
}

/** A file's state as captured at the end of a checkpoint interval. */
export interface CheckpointFile {
  /** Workspace-relative path (POSIX separators). */
  path: string;
  /** Status relative to the file's state at the previous checkpoint. */
  status: ChangeStatus;
  /**
   * Content-addressed blob holding the file's bytes at checkpoint time.
   * Undefined for deleted files and for files over the size limit
   * (those cannot be diffed or restored for this checkpoint).
   */
  blobHash?: string;
}

/** Location of the agent message that produced a turn, when known. */
export interface AgentMessageSource {
  agent: Extract<AgentType, "claude" | "codex">;
  /** Local transcript JSONL path, used as a reliable fallback target. */
  transcriptPath: string;
  /** Claude/Codex session or thread id, when the platform exposes one. */
  sessionId?: string;
  /** 1-based line number in the local transcript JSONL file. */
  lineNumber?: number;
}

/**
 * A checkpoint marks an agent-turn boundary (one user message → one turn of
 * work). It records every file that changed since the previous checkpoint
 * (or since the session baseline, for the first one).
 */
export interface Checkpoint {
  id: string;
  /** Usually the user message that started the turn. */
  label: string;
  /** Original agent message location, if the watcher could identify it. */
  source?: AgentMessageSource;
  createdAt: number;
  files: CheckpointFile[];
}

// ---- Turn traces (read on demand from agent transcripts, never persisted) ---

/** What an agent step did. "message" = text the agent wrote to the user. */
export type StepKind =
  | "read"
  | "search"
  | "edit"
  | "write"
  | "delete"
  | "command"
  | "agent"
  | "web"
  | "message"
  | "other";

/** Outcome of a step. "running" = no result recorded yet. */
export type StepStatus = "ok" | "error" | "rejected" | "interrupted" | "running";

export interface StepFile {
  /** Workspace-relative POSIX path, or the absolute path when outside it. */
  path: string;
  inWorkspace: boolean;
  access: "read" | "write";
  /** For writes, how the step changed the file, when the transcript says. */
  change?: ChangeStatus;
}

/** One tool call (or message) the agent made during a turn. */
export interface TurnStep {
  id: string;
  kind: StepKind;
  /** Tool name as the agent called it, e.g. "Edit" or "exec_command". */
  tool: string;
  /** One-line summary: a path, a command, a query. */
  title: string;
  /** The agent's own short description of the step, when it gave one. */
  note?: string;
  /** Full command, subagent prompt or message text (truncated). */
  detail?: string;
  timestamp?: number;
  status: StepStatus;
  files: StepFile[];
  /** Lines added/removed, when the transcript records the patch. */
  added?: number;
  removed?: number;
  /** The user changed the proposed edit before it was applied. */
  userModified?: boolean;
  /** Steps run by a subagent this step launched. */
  children?: TurnStep[];
}

/** Everything the agent did between one user message and the next. */
export interface TurnTrace {
  agent: AgentMessageSource["agent"];
  /** Full text of the user message that started the turn. */
  prompt?: string;
  startedAt?: number;
  /** Timestamp of the last recorded entry of the turn. */
  endedAt?: number;
  steps: TurnStep[];
  /** True when the turn was too long to read completely. */
  truncated: boolean;
}

export interface AgentSession {
  id: string;
  title: string;
  agent: AgentType;
  startedAt: number;
  endedAt?: number;
  /** Cumulative changes vs the session baseline. */
  changedFiles: AgentChangedFile[];
  /** Turn-by-turn history. Empty for purely manual sessions. */
  checkpoints: Checkpoint[];
  /** Changes since the last checkpoint (the in-progress turn). */
  pendingFiles: AgentChangedFile[];
  /** Label for the in-progress turn (the latest user message). */
  currentTurnLabel?: string;
  /** Source for the in-progress turn's latest user message. */
  currentTurnSource?: AgentMessageSource;
  status: SessionStatus;
}
