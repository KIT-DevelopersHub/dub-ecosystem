// Raw GitHub webhook payload -> normalized snapshots. Pure.
import type { IssueSnapshot } from "../domain/types";

export interface ParsedIssueEvent {
  action: string; // opened | edited | closed | reopened | labeled | assigned | ...
  senderLogin: string | null;
  issue: IssueSnapshot;
}

interface RawLabel {
  name?: string;
}
interface RawUser {
  login?: string;
}
interface RawIssue {
  number?: number;
  node_id?: string;
  title?: string;
  body?: string | null;
  state?: string;
  labels?: RawLabel[];
  assignees?: RawUser[];
  updated_at?: string;
}
interface RawIssuePayload {
  action?: string;
  issue?: RawIssue;
  sender?: RawUser;
  repository?: { name?: string; owner?: RawUser };
}

/** Parse an `issues`/`issue_comment`-family webhook body. Returns null if unusable. */
export function parseIssueEvent(payload: unknown): ParsedIssueEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as RawIssuePayload;
  const issue = p.issue;
  const repository = p.repository;
  if (!issue || typeof issue.number !== "number") return null;
  const owner = repository?.owner?.login;
  const repo = repository?.name;
  if (!owner || !repo) return null;
  const state = issue.state === "closed" ? "closed" : "open";
  return {
    action: p.action ?? "unknown",
    senderLogin: p.sender?.login ?? null,
    issue: {
      owner,
      repo,
      number: issue.number,
      nodeId: issue.node_id ?? "",
      title: issue.title ?? "",
      body: issue.body ?? null,
      state,
      labels: (issue.labels ?? []).map((l) => l.name ?? "").filter((n) => n.length > 0),
      assignees: (issue.assignees ?? []).map((a) => a.login ?? "").filter((n) => n.length > 0),
      updatedAt: issue.updated_at ?? new Date().toISOString(),
    },
  };
}

/** Which GitHub `X-GitHub-Event` kinds this service acts on. */
export function isIssueEventKind(eventKind: string): boolean {
  return eventKind === "issues" || eventKind === "issue_comment";
}
