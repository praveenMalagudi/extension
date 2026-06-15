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
