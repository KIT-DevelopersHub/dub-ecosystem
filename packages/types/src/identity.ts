// identity — identity-roster namespace. Owns the frozen RBAC permission catalog.
import type { UserId, OrgId, RoleId, ISODateTime, CursorQuery } from "./common";

export interface PermissionCatalogEntry {
  key: string;
  name: string; // human-readable (FE7 display)
  description: string;
  domain: string; // grouping: identity / event / task / ...
  dangerous: boolean; // FE7 warning + auth-client always-sync check
}

// P0 frozen catalog (57 keys). `<domain>:<action>` (self-service keys carry a
// `:self` scope segment), lowercase, no wildcard, default deny. Adding a key =
// contract change (theme2). The github:* / drive:* / webhook:read keys were
// promoted from wire-boundary string casts (github-sync, drive-proxy,
// webhook-ingest) into the closed union so /authz/check no longer default-denies
// them as unknown keys. notif:inbox:self / notif:prefs:self back FE5's
// self-service inbox + preference routes (promoted from the shell composition).
//
// `app:<id>:view` / `app:<id>:edit` (domain "app") — the PER-APP access tier.
// EVERY launcher app (APP_MANIFEST) gets its OWN graded access pair so an admin can
// turn each app on/off for a role INDIVIDUALLY, even apps that used to ride a shared
// domain permission (gantt rode task:read alongside マイタスク; 参加届 rode identity:read
// alongside 運営メンバー — toggling the domain key hit both). `:view` = 有効化 (open/閲覧
// できる); `:edit` IMPLIES view and additionally allows create/edit inside the app
// (編集・作成まで). These keys are the actual FE gate: the shell launcher greys and the
// route guard 403s an app whose `app:<id>:view` the role lacks; write UIs are gated on
// `app:<id>:edit`. Kept in lockstep with APP_MANIFEST by the app-registry CI test.
export const PERMISSION_CATALOG = [
  { key: "identity:read", name: "Read roster", description: "View roster, roles and the permission catalog", domain: "identity", dangerous: false },
  { key: "identity:admin", name: "Administer identity", description: "Update users, invite, role CRUD, grant/revoke", domain: "identity", dangerous: true },
  { key: "event:read", name: "Read events", description: "View events/actions (gantt view reuses this)", domain: "event", dangerous: false },
  { key: "event:write", name: "Write events", description: "Create/update events and actions", domain: "event", dangerous: false },
  { key: "event:admin", name: "Administer events", description: "Archive and closed-phase transitions", domain: "event", dangerous: true },
  { key: "task:read", name: "Read tasks", description: "View tasks", domain: "task", dangerous: false },
  { key: "task:write", name: "Write tasks", description: "Create/update tasks and edit dependencies", domain: "task", dangerous: false },
  { key: "task:delete", name: "Delete tasks", description: "Soft-delete tasks", domain: "task", dangerous: false },
  { key: "file:read", name: "Read files", description: "View/search metadata and download from R2", domain: "file", dangerous: false },
  { key: "file:write", name: "Write files", description: "Register/update/link/upload", domain: "file", dangerous: false },
  { key: "file:admin", name: "Administer files", description: "Force visibility/owner changes and restore", domain: "file", dangerous: true },
  { key: "notif:send", name: "Send notifications", description: "POST /notify (service-to-service)", domain: "notif", dangerous: false },
  { key: "notif:admin", name: "Administer notifications", description: "Search delivery records", domain: "notif", dangerous: false },
  { key: "notif:inbox:self", name: "Read own inbox", description: "View and manage one's own notification inbox", domain: "notif", dangerous: false },
  { key: "notif:prefs:self", name: "Manage own notification preferences", description: "View and update one's own notification preferences", domain: "notif", dangerous: false },
  { key: "notif:broadcast_publish", name: "Publish member broadcasts", description: "Publish an admin notification to all members from the Notification management screen", domain: "notif", dangerous: false },
  { key: "mail:send", name: "Send mail", description: "Send email", domain: "mail", dangerous: true },
  { key: "mail:read", name: "Read mail", description: "View messages/threads/rules", domain: "mail", dangerous: false },
  { key: "mail:read_all", name: "Read all mail", description: "View every user's mail (oversight/archive)", domain: "mail", dangerous: true },
  { key: "mail:admin", name: "Administer mail", description: "Manage mailbox/watch/rules", domain: "mail", dangerous: true },
  { key: "chat:create", name: "Create channels", description: "Create chat channels", domain: "chat", dangerous: false },
  { key: "chat:moderate", name: "Moderate chat", description: "Manage channels and delete others' messages", domain: "chat", dangerous: true },
  { key: "usage:view", name: "View usage dashboard", description: "View the free-tier usage & billing-guard dashboard", domain: "usage", dangerous: false },
  { key: "infra:read", name: "Read infra", description: "View sites/deployments/dns/domains", domain: "infra", dangerous: false },
  { key: "infra:deploy", name: "Deploy", description: "Execute deployments", domain: "infra", dangerous: true },
  { key: "infra:dns", name: "Change DNS", description: "Modify DNS records", domain: "infra", dangerous: true },
  { key: "infra:admin", name: "Administer infra", description: "Register sites and manage allowed zones", domain: "infra", dangerous: true },
  { key: "audit:read", name: "Read audit log", description: "Search/query audit records", domain: "audit", dangerous: false },
  { key: "github:read", name: "Read GitHub", description: "View GitHub sync state, repos and pull requests", domain: "github", dangerous: false },
  { key: "github:write", name: "Write GitHub", description: "Create/update GitHub-side resources via sync", domain: "github", dangerous: false },
  { key: "github:sync", name: "Sync GitHub", description: "Trigger GitHub synchronization jobs", domain: "github", dangerous: false },
  { key: "github:admin", name: "Administer GitHub", description: "Manage the GitHub integration, tokens and webhooks", domain: "github", dangerous: true },
  { key: "drive:read", name: "Read Drive", description: "View/search Google Drive metadata and download content", domain: "drive", dangerous: false },
  { key: "drive:write", name: "Write Drive", description: "Upload/update Google Drive files", domain: "drive", dangerous: false },
  { key: "webhook:read", name: "Read webhooks", description: "Search webhook delivery records", domain: "webhook", dangerous: false },
  // ── per-app access tier (domain "app") — one graded pair per launcher app ──────
  { key: "app:events:view", name: "Open イベント app", description: "Open and view the イベント app", domain: "app", dangerous: false },
  { key: "app:events:edit", name: "Edit in イベント app", description: "Create/edit inside the イベント app (implies view)", domain: "app", dangerous: false },
  { key: "app:tasks:view", name: "Open マイタスク app", description: "Open and view the マイタスク app", domain: "app", dangerous: false },
  { key: "app:tasks:edit", name: "Edit in マイタスク app", description: "Create/edit inside the マイタスク app (implies view)", domain: "app", dangerous: false },
  { key: "app:gantt:view", name: "Open ガントチャート app", description: "Open and view the ガントチャート app", domain: "app", dangerous: false },
  { key: "app:gantt:edit", name: "Edit in ガントチャート app", description: "Create/edit inside the ガントチャート app (implies view)", domain: "app", dangerous: false },
  { key: "app:notifications:view", name: "Open 通知 app", description: "Open and view the 通知 app", domain: "app", dangerous: false },
  { key: "app:notifications:edit", name: "Edit in 通知 app", description: "Manage/act inside the 通知 app (implies view)", domain: "app", dangerous: false },
  { key: "app:chat:view", name: "Open チャット app", description: "Open and view the チャット app", domain: "app", dangerous: false },
  { key: "app:chat:edit", name: "Edit in チャット app", description: "Create/post/manage inside the チャット app (implies view)", domain: "app", dangerous: false },
  { key: "app:mail:view", name: "Open メール app", description: "Open and view the メール app", domain: "app", dangerous: false },
  { key: "app:mail:edit", name: "Edit in メール app", description: "Compose/send inside the メール app (implies view)", domain: "app", dangerous: false },
  { key: "app:usage:view", name: "Open 無料枠/課金ガード app", description: "Open and view the 無料枠 / 課金ガード app", domain: "app", dangerous: false },
  { key: "app:usage:edit", name: "Edit in 無料枠/課金ガード app", description: "Act inside the 無料枠 / 課金ガード app (implies view)", domain: "app", dangerous: false },
  { key: "app:members:view", name: "Open 運営メンバー app", description: "Open and view the 運営メンバー app", domain: "app", dangerous: false },
  { key: "app:members:edit", name: "Edit in 運営メンバー app", description: "Edit inside the 運営メンバー app (implies view)", domain: "app", dangerous: false },
  { key: "app:participation:view", name: "Open 参加届 app", description: "Open and view the 参加届 app", domain: "app", dangerous: false },
  { key: "app:participation:edit", name: "Edit in 参加届 app", description: "Manage responses inside the 参加届 app (implies view)", domain: "app", dangerous: false },
  { key: "app:driveshare:view", name: "Open Drive共有 app", description: "Open and view the Drive共有 app", domain: "app", dangerous: false },
  { key: "app:driveshare:edit", name: "Edit in Drive共有 app", description: "Manage sharing inside the Drive共有 app (implies view)", domain: "app", dangerous: false },
  { key: "app:admin:view", name: "Open 管理 app", description: "Open and view the 管理 app", domain: "app", dangerous: false },
  { key: "app:admin:edit", name: "Edit in 管理 app", description: "Act inside the 管理 app (implies view)", domain: "app", dangerous: false },
] as const satisfies readonly PermissionCatalogEntry[];

// Closed union of the 57 keys (open `${string}:${string}` template retired).
export type PermissionKey = (typeof PERMISSION_CATALOG)[number]["key"];

export type UserStatus = "active" | "invited" | "disabled" | "rejected";

export interface IdentityUser {
  id: UserId;
  orgId: OrgId;
  displayName: string;
  email: string;
  githubLogin: string | null;
  avatarUrl: string | null;
  status: UserStatus;
  roleIds: RoleId[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface IdentityUserDetail extends IdentityUser {
  permissions: PermissionKey[]; // effective, resolved from roles
}

export interface UserSummary {
  id: UserId;
  displayName: string;
  avatarUrl: string | null;
  // Optional (additive): self email for identity display (e.g. shell header).
  // api-gateway /me populates it from the identity master; other summary
  // producers (roster search etc.) may omit it.
  email?: string;
}

export interface Org {
  id: OrgId;
  name: string;
  createdAt: ISODateTime;
}

export interface Role {
  id: RoleId;
  orgId: OrgId;
  name: string; // "admin" | "organizer" | "member" (system) + custom
  permissions: PermissionKey[];
  isSystem: boolean;
}

// ---- authz check (single source used by @dub/auth-client) ----
export interface AuthzQuery {
  permission: PermissionKey;
  resourceType?: string; // P0: "event" scope max; task-scope is P1
  resourceId?: string;
}

export interface AuthzCheckRequest {
  subjectUserId: UserId;
  orgId: OrgId;
  checks: AuthzQuery[]; // 1..20
}

export interface AuthzDecision {
  allowed: boolean;
  evaluatedAt: ISODateTime;
  ttlSeconds: number; // server-specified cache TTL (default 60)
}

export interface AuthzCheckResponse {
  decisions: AuthzDecision[]; // same order as request.checks
}

// ---- invite / provision (theme2 B3/B4) ----
export interface InviteUserRequest {
  email: string;
  displayName?: string;
  roleIds?: RoleId[];
}
export interface ProvisionUserRequest {
  email: string;
  displayName: string;
  githubLogin?: string;
}
export interface ListUsersQuery extends CursorQuery {
  ids?: string; // comma-separated batch (?ids=)
  status?: UserStatus;
  /** Canonical role filter (a roleId). */
  role?: RoleId;
  /**
   * @deprecated Legacy alias for `role` (the FE7 client's original spelling). The server
   * still accepts it (`role ?? roleKey`), so it stays in the contract as a documented
   * deprecated alias; new callers must use `role`. Do not remove without a migration.
   */
  roleKey?: RoleId;
  q?: string; // free-text search
}
/** GET /identity/orgs — cursor-only. */
export type ListOrgsQuery = CursorQuery;
/** GET /identity/roles — cursor-only. */
export type ListRolesQuery = CursorQuery;

// ── Wire contract (query params) ─────────────────────────────────────────────
// SINGLE source of truth for the query-parameter *names* identity-roster's public
// (/identity/*) read endpoints put on the wire. The server (identity-roster app.ts) and
// the OpenAPI spec (docs/openapi/identity-roster.yaml) are reconciled against this map in
// CI (see @dub/e2e-smoke wire-params.test.ts). `roleKey` is intentionally listed as an
// accepted (deprecated) alias of `role` — the server reads both; canonical is `role`.
// The internal `/internal/users` route (not in the public spec) reads a subset of these
// same keys, so it needs no separate entry. See docs/api-contracts/_wire-contract-enforcement.md.
export const IDENTITY_WIRE = {
  listOrgs: { method: "GET", path: "/identity/orgs", query: ["cursor", "limit"] },
  listUsers: {
    method: "GET",
    path: "/identity/users",
    query: ["cursor", "limit", "ids", "status", "role", "roleKey", "q"],
  },
  listRoles: { method: "GET", path: "/identity/roles", query: ["cursor", "limit"] },
} as const;

// Compile-time tie: each endpoint's query keys must be real keys of its query type.
type _IdentityWireKeysAreTyped =
  (typeof IDENTITY_WIRE.listOrgs.query)[number] extends keyof ListOrgsQuery
    ? (typeof IDENTITY_WIRE.listUsers.query)[number] extends keyof ListUsersQuery
      ? (typeof IDENTITY_WIRE.listRoles.query)[number] extends keyof ListRolesQuery
        ? true
        : never
      : never
    : never;
const _identityWireKeyGuard: _IdentityWireKeysAreTyped = true;
void _identityWireKeyGuard;
