// githubSync — github-sync namespace.
import type { TaskId, EventId, ISODateTime, Paginated, CursorQuery } from "./common";

export type TriggerScope = "task" | "event" | "all";
export type SyncRunScope = "incremental" | "full";
/** Link↔issue reconciliation state (mirrors the service domain SyncState). */
export type SyncState = "in_sync" | "pending" | "conflict" | "error";

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
  /** Repeatable filter (`?syncState=pending&syncState=error`); the server reads it via
   *  c.req.queries("syncState"). Additive: was undocumented in type + spec before. */
  syncState?: SyncState[];
}
export type ListLinksResponse = Paginated<GithubLink>;

/** GET /github/repos query (event-scoped repo list). */
export interface ListReposQuery extends CursorQuery {
  eventId?: EventId;
}
/** GET /github/sync/runs query (cursor-only). */
export type ListSyncRunsQuery = CursorQuery;

// ── Wire contract (query params) ─────────────────────────────────────────────
// SINGLE source of truth for the query-parameter *names* github-sync's read endpoints
// put on the wire. The server (github-sync app.ts) and the OpenAPI spec
// (docs/openapi/github-sync.yaml) are reconciled against this map in CI (see
// @dub/e2e-smoke wire-params.test.ts). Renaming a key here is the only legitimate way to
// change a wire param. See docs/api-contracts/_wire-contract-enforcement.md.
export const GITHUB_SYNC_WIRE = {
  listLinks: { method: "GET", path: "/github/links", query: ["cursor", "limit", "taskId", "repo", "syncState"] },
  listRepos: { method: "GET", path: "/github/repos", query: ["cursor", "limit", "eventId"] },
  listSyncRuns: { method: "GET", path: "/github/sync/runs", query: ["cursor", "limit"] },
} as const;

// Compile-time tie: each endpoint's query keys must be real keys of its query type.
type _GithubWireKeysAreTyped =
  (typeof GITHUB_SYNC_WIRE.listLinks.query)[number] extends keyof ListLinksQuery
    ? (typeof GITHUB_SYNC_WIRE.listRepos.query)[number] extends keyof ListReposQuery
      ? (typeof GITHUB_SYNC_WIRE.listSyncRuns.query)[number] extends keyof ListSyncRunsQuery
        ? true
        : never
      : never
    : never;
const _githubWireKeyGuard: _GithubWireKeysAreTyped = true;
void _githubWireKeyGuard;
