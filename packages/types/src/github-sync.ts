// githubSync — github-sync namespace.
import type { TaskId, ISODateTime, Paginated, CursorQuery } from "./common";

export type TriggerScope = "task" | "event" | "all";
export type SyncRunScope = "incremental" | "full";

export interface TriggerSyncRequest {
  scope: TriggerScope;
  targetId?: string;
  runScope?: SyncRunScope;
}
export interface GithubLink {
  taskId: TaskId;
  repo: string; // "owner/name"
  issueNumber: number;
  url: string;
  linkedAt: ISODateTime;
}
export interface ListLinksQuery extends CursorQuery {
  taskId?: TaskId;
  repo?: string;
}
export type ListLinksResponse = Paginated<GithubLink>;
