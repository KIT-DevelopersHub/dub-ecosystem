// identity — identity-roster namespace. Owns the frozen RBAC permission catalog.
import type { UserId, OrgId, RoleId, ISODateTime } from "./common";

export interface PermissionCatalogEntry {
  key: string;
  name: string; // human-readable (FE7 display)
  description: string;
  domain: string; // grouping: identity / event / task / ...
  dangerous: boolean; // FE7 warning + auth-client always-sync check
}

// P0 frozen catalog (30 keys). `<domain>:<action>` 2-segment, lowercase, no
// wildcard, default deny. Adding a key = contract change (theme2). The
// github:* / drive:* / webhook:read keys were promoted from wire-boundary
// string casts (github-sync, drive-proxy, webhook-ingest) into the closed
// union so /authz/check no longer default-denies them as unknown keys.
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
  { key: "mail:send", name: "Send mail", description: "Send email", domain: "mail", dangerous: true },
  { key: "mail:read", name: "Read mail", description: "View messages/threads/rules", domain: "mail", dangerous: false },
  { key: "mail:admin", name: "Administer mail", description: "Manage mailbox/watch/rules", domain: "mail", dangerous: true },
  { key: "chat:create", name: "Create channels", description: "Create chat channels", domain: "chat", dangerous: false },
  { key: "chat:moderate", name: "Moderate chat", description: "Manage channels and delete others' messages", domain: "chat", dangerous: true },
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
] as const satisfies readonly PermissionCatalogEntry[];

// Closed union of the 30 keys (open `${string}:${string}` template retired).
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
export interface ListUsersQuery {
  ids?: string; // comma-separated batch (?ids=)
  cursor?: string;
  limit?: number;
}
