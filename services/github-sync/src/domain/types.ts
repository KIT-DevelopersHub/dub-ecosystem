// Service-internal domain types.
//
// NOTE (contract divergence, flagged for parent): the frozen `@dub/types`
// `githubSync` namespace is intentionally minimal (GithubLink = {taskId, repo,
// issueNumber, url, linkedAt}; TriggerScope = "task"|"event"|"all"). The P0a
// design proposes a richer surface (repo config, sync runs, syncState, ...).
// Foundation packages are frozen and MUST NOT be edited by this unit, so the
// richer types live here and the public API projects rows down to the frozen
// `githubSync.*` shapes. See the summary notes for the reconciliation ask (8-N5
// permission keys + whether to enrich @dub/types.githubSync).

import type { common, task } from "@dub/types";

export type GithubRepoId = string; // ghr_<ULID>
export type GithubLinkId = string; // ghl_<ULID>
export type SyncRunId = string; // ghs_<ULID>

export type SyncOrigin = "internal" | "github";
export type SyncDirection = "bidirectional" | "internal_to_github" | "github_to_internal";
export type SyncState = "in_sync" | "pending" | "conflict" | "error";
export type SyncRunStatus = "queued" | "running" | "succeeded" | "partial_failed" | "failed";
// Public trigger scope reuses the frozen githubSync.TriggerScope ("task"|"event"|"all").
// The run-history scope adds the system-origin kinds.
export type SyncRunScope = "task" | "event" | "all" | "repo" | "webhook" | "cron";

export interface GithubRepoConfig {
  id: GithubRepoId;
  owner: string;
  repo: string;
  eventId: common.EventId;
  defaultActionId: string | null;
  origin: SyncOrigin;
  direction: SyncDirection;
  enabled: boolean;
  installationId: string | null;
  projectNumber: number | null;
  labelFilter: string[];
  createdBy: string;
  createdAt: common.ISODateTime;
  updatedAt: common.ISODateTime;
}

export interface RegisterRepoRequest {
  owner: string;
  repo: string;
  eventId: common.EventId;
  defaultActionId?: string;
  origin?: SyncOrigin; // default "github"
  direction?: SyncDirection; // default "bidirectional"
  installationId?: string;
  projectNumber?: number;
  labelFilter?: string[];
}

export interface UpdateRepoRequest {
  enabled?: boolean;
  eventId?: common.EventId;
  defaultActionId?: string | null;
  origin?: SyncOrigin;
  direction?: SyncDirection;
  installationId?: string | null;
  projectNumber?: number | null;
  labelFilter?: string[];
}

// Internal link row (superset of the frozen githubSync.GithubLink projection).
export interface LinkRecord {
  id: GithubLinkId;
  taskId: common.TaskId;
  repoId: GithubRepoId;
  owner: string;
  repo: string; // repository name (not "owner/name")
  issueNumber: number;
  issueNodeId: string;
  projectItemId: string | null;
  syncState: SyncState;
  lastSyncedAt: common.ISODateTime | null;
  lastGithubUpdatedAt: common.ISODateTime | null;
  lastTaskVersion: number | null;
  lastError: string | null;
  createdAt: common.ISODateTime;
  updatedAt: common.ISODateTime;
}

// Manual link request (not present in the frozen minimal githubSync namespace).
export interface CreateLinkRequest {
  taskId: common.TaskId;
  owner: string;
  repo: string;
  issueNumber: number;
}

export interface SyncRunStats {
  created: number;
  updated: number;
  skipped: number;
  conflicts: number;
  failed: number;
}

export interface SyncRunRecord {
  id: SyncRunId;
  scope: SyncRunScope;
  repoId: GithubRepoId | null;
  status: SyncRunStatus;
  stats: SyncRunStats;
  triggeredBy: string | null;
  startedAt: common.ISODateTime | null;
  finishedAt: common.ISODateTime | null;
  error: string | null;
  createdAt: common.ISODateTime;
}

// A normalized view of a GitHub issue (what the mapper reads/writes).
export interface IssueSnapshot {
  owner: string;
  repo: string;
  number: number;
  nodeId: string;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: string[];
  assignees: string[]; // github logins
  updatedAt: common.ISODateTime;
}

// A normalized view of a task (what the mapper reads/writes). task-service's frozen
// Task has no free-form labels field, so labels are a GitHub-side representation of
// status only (status:* markers); the task carries no label list.
export interface TaskSnapshot {
  id: common.TaskId;
  eventId: common.EventId;
  title: string;
  description: string | null;
  status: task.TaskStatus;
  assigneeId: common.UserId | null;
  version: number;
  updatedAt: common.ISODateTime;
}

export const emptyStats = (): SyncRunStats => ({
  created: 0,
  updated: 0,
  skipped: 0,
  conflicts: 0,
  failed: 0,
});
