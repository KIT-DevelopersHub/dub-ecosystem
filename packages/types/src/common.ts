// common — the only namespace whose "content" @dub/types owns.
// Shared primitives: IDs, time, pagination, optimistic locking, declared constants.

// ---- ids.ts (D1: prefix-ULID plain string, no brand; newId(prefix) is the only mint) ----
export type UserId = string;
export type OrgId = string;
export type RoleId = string;
export type EventId = string;
export type ActionId = string;
export type TaskId = string;
export type TeamId = string;
export type ChannelId = string;
export type MessageId = string;
export type FileId = string; // file-meta minted ULID (Drive raw id is drive.DriveFileId)
export type NotificationId = string;
export type AuditLogId = string;
export type DeploymentId = string;

// Correlation id: wire field name is `requestId` (E1 resolved to requestId;
// header is x-dub-request-id). The legacy `CorrelationId` alias is retired.
export type RequestId = string;

// ---- time.ts (D2) ----
export type ISODateTime = string; // ISO8601 UTC, e.g. "2026-08-09T05:00:00Z"
export type ISODate = string; // "2026-08-09"
// Exception (theme10 frozen): session-expiry fields carry epoch-ms `number`
// (gateway.MeResponse.sessionExpiresAt, auth.SessionInfo).
export type EpochMs = number;

// ---- pagination.ts (D3: opaque cursor, offset paging forbidden) ----
export interface CursorQuery {
  cursor?: string; // opaque; previous response's nextCursor
  limit?: number; // default 50 / max 200
}
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null; // null = end of results
}

// ---- mutation.ts (D4: optimistic lock, no exceptions incl. mobile) ----
export interface Versioned {
  version: number; // mismatch -> 409 <SERVICE>_VERSION_CONFLICT
}

// ---- constants.ts (declared-list constants; D5) ----
export const API_PREFIX = "/api/v1";
export const MOBILE_API_PREFIX = "/m/v1";
// E4: value follows infra-d1-seed's canonical org id at Apply time. Prefix-ULID form.
export const DUB_DEFAULT_ORG_ID = "org_devhub";

// ---- public app URL (SoT) ----
// The SPA (fe2-app-shell) users open. Every user-visible link (account mail, dialogs,
// message permalinks) derives from this; switching to the custom domain = edit this line
// (+ api-gateway wrangler.free.toml APP_BASE_URL). app.developershub.jp has no DNS yet.
export const PUBLIC_APP_BASE_URL = "https://dub-fe2-app-shell.developershub-site.workers.dev";
/** Planned custom domain (not DNS-configured yet). Kept in allow-lists only. */
export const PLANNED_APP_CUSTOM_ORIGIN = "https://app.developershub.jp";
/** Origins the production SPA may be served from (CORS / WS / link-unfurl allow-lists). */
export const PUBLIC_APP_ORIGINS: readonly string[] = [PUBLIC_APP_BASE_URL, PLANNED_APP_CUSTOM_ORIGIN];

// ---- bindings.ts (union実体は infra レジストリが正本・型面のみ) ----
export type ServiceBindingName = string; // "SVC_" + UPPER_SNAKE, e.g. "SVC_DRIVE_PROXY"
