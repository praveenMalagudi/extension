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

export interface AgentSession {
  id: string;
  title: string;
  agent: AgentType;
  startedAt: number;
  endedAt?: number;
  changedFiles: AgentChangedFile[];
  status: SessionStatus;
}
