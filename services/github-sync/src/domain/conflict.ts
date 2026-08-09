// Conflict detection + resolution direction. Pure.
import type { LinkRecord, SyncOrigin } from "./types";

export interface ChangeSignals {
  // did GitHub change since the value we recorded at last sync?
  githubChanged: boolean;
  // did the task change since the version we recorded at last sync?
  taskChanged: boolean;
}

/** Both sides moved since lastSynced -> conflict. */
export function isConflict(s: ChangeSignals): boolean {
  return s.githubChanged && s.taskChanged;
}

/** The origin that wins a conflict is the repo's configured source of truth. */
export function conflictWinner(origin: SyncOrigin): SyncOrigin {
  return origin;
}

/** Has the GitHub issue moved since the link's last recorded issue.updated_at? */
export function githubMoved(link: LinkRecord, issueUpdatedAt: string): boolean {
  if (link.lastGithubUpdatedAt === null) return true;
  return issueUpdatedAt > link.lastGithubUpdatedAt;
}

/** Has the task moved since the link's last recorded task.version? */
export function taskMoved(link: LinkRecord, taskVersion: number): boolean {
  if (link.lastTaskVersion === null) return true;
  return taskVersion > link.lastTaskVersion;
}
