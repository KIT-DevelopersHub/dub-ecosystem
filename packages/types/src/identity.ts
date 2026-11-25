// identity — identity-roster namespace. Owns the frozen RBAC permission catalog.
import type { UserId, OrgId, RoleId, ISODateTime, CursorQuery } from "./common";

export interface PermissionCatalogEntry {
  key: string;
  name: string; // human-readable (FE7 display)
  description: string;
  domain: string; // grouping: identity / event / task / ...
  dangerous: boolean; // FE7 warning + auth-client always-sync check
}

// P0 frozen catalog (97 keys). `<domain>:<action>` (self-service keys carry a
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
  // Receive-audience keys: who an audience-addressed notification is delivered to. The
  // notification service resolves "管理者向け" / "全体" recipients as the users whose roles hold
  // the key (identity GET /internal/permission-holders), so ロール管理 decides who gets what.
  { key: "notif:receive_admin", name: "Receive admin notifications", description: "Receive admin-audience notifications (deploys, inquiries/feedback, 参加届, ops alerts)", domain: "notif", dangerous: false },
  { key: "notif:receive_all", name: "Receive org-wide notifications", description: "Receive notifications addressed to all members (announcements, release notes)", domain: "notif", dangerous: false },
  { key: "mail:send", name: "Send mail", description: "Send email", domain: "mail", dangerous: true },
  { key: "mail:read", name: "Read mail", description: "View messages/threads/rules", domain: "mail", dangerous: false },
  { key: "mail:read_all", name: "Read all mail", description: "View every user's mail (oversight/archive)", domain: "mail", dangerous: true },
  { key: "mail:read_role_shared", name: "Read role-shared mail", description: "View mail delivered to other holders of a role that carries this key", domain: "mail", dangerous: true },
  { key: "mail:admin", name: "Administer mail", description: "Manage mailbox/watch/rules", domain: "mail", dangerous: true },
  // チャンネル作成は積み上げ式の 3 択 (作成できない / パブリックのみ / プライベートも)。ロール管理は
  // トグルではなく 1 つの選択肢として出す (policy.chatCreateScopeOf)。create_private ⇒ create。
  { key: "chat:create", name: "Create channels", description: "Create public chat channels and start DMs", domain: "chat", dangerous: false },
  { key: "chat:create_private", name: "Create private channels", description: "Also create private chat channels (implies chat:create)", domain: "chat", dangerous: false },
  { key: "chat:moderate", name: "Moderate chat", description: "Manage channels and delete others' messages", domain: "chat", dangerous: true },
  { key: "chat:delete_channel", name: "Delete channels", description: "Permanently delete chat channels and all their messages", domain: "chat", dangerous: true },
  { key: "chat:slack_import", name: "Import from Slack", description: "Import Slack channel history (messages, threads, reactions, files) into new chat channels", domain: "chat", dangerous: true },
  { key: "chat:emoji_import", name: "Import Slack custom emoji", description: "Import the Slack workspace's custom emoji (images) for use in chat reactions", domain: "chat", dangerous: true },
  { key: "chat:manage_sections", name: "Manage chat sections", description: "Create, rename, reorder and delete the org-wide chat sidebar sections and assign channels to them", domain: "chat", dangerous: false },
  { key: "chat:change_visibility", name: "Change channel visibility", description: "Switch a chat channel between public and private", domain: "chat", dangerous: true },
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
  // Drive共有 の「設定」(the Google accounts it acts as). Two toggles in Drive共有's 詳細設定;
  // settings_edit IMPLIES settings_view (policy.normalizeAppAccessKeys).
  { key: "drive:settings_view", name: "View Drive共有 settings", description: "Open Drive共有's settings and see its Google accounts (read-only)", domain: "drive", dangerous: false },
  { key: "drive:settings_edit", name: "Edit Drive共有 settings", description: "Add/switch/remove the Google accounts Drive共有 acts as (implies view)", domain: "drive", dangerous: true },
  // カレンダー > ミーティング (meetings on the shared Google account, drive-share-service /meetings).
  // Two toggles in カレンダー's 詳細設定; meetings_edit IMPLIES meetings_view (policy.normalizeAppAccessKeys).
  { key: "calendar:schedule_edit", name: "Edit schedules", description: "Add/change/delete 予定 in the カレンダー app (saved as the caller's tasks)", domain: "calendar", dangerous: false },
  { key: "calendar:meetings_view", name: "View meetings", description: "See the meetings set up on the shared Google account (カレンダー > ミーティング)", domain: "calendar", dangerous: false },
  { key: "calendar:meetings_edit", name: "Edit meetings", description: "Create/change/delete meetings on the shared Google account and invite role members (implies view)", domain: "calendar", dangerous: true },
  { key: "webhook:read", name: "Read webhooks", description: "Search webhook delivery records", domain: "webhook", dangerous: false },
  // ── per-app access tier (domain "app") — one graded pair per launcher app ──────
  { key: "app:events:view", name: "Open イベント app", description: "Open and view the イベント app", domain: "app", dangerous: false },
  { key: "app:events:edit", name: "Edit in イベント app", description: "Create/edit inside the イベント app (implies view)", domain: "app", dangerous: false },
  { key: "app:tasks:view", name: "Open マイタスク app", description: "Open and view the マイタスク app", domain: "app", dangerous: false },
  { key: "app:tasks:edit", name: "Edit in マイタスク app", description: "Create/edit inside the マイタスク app (implies view)", domain: "app", dangerous: false },
  { key: "app:gantt:view", name: "Open ガントチャート app", description: "Open and view the ガントチャート app", domain: "app", dangerous: false },
  { key: "app:gantt:edit", name: "Edit in ガントチャート app", description: "Create/edit inside the ガントチャート app (implies view)", domain: "app", dangerous: false },
  { key: "app:calendar:view", name: "Open カレンダー app", description: "Open and view the カレンダー app", domain: "app", dangerous: false },
  { key: "app:calendar:edit", name: "Edit in カレンダー app", description: "Create/edit inside the カレンダー app (implies view)", domain: "app", dangerous: false },
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
  { key: "lp:publish", name: "Publish LP version", description: "Switch which LP version is live on the public conference site", domain: "lp", dangerous: true },
  { key: "app:lp:view", name: "Open LP管理 app", description: "Open and view the LP管理 app", domain: "app", dangerous: false },
  { key: "app:lp:edit", name: "Edit in LP管理 app", description: "Manage LP versions inside the LP管理 app (implies view)", domain: "app", dangerous: false },
  { key: "app:commander:view", name: "Open Commander app", description: "Open and view the Commander app (drives the local Claude Code exec bridge)", domain: "app", dangerous: true },
  { key: "app:commander:edit", name: "Edit in Commander app", description: "Run commands / advance phases inside the Commander app (implies view)", domain: "app", dangerous: true },
  { key: "hr:read", name: "Read HR applicants", description: "View applicants, their selection history and new-member onboarding progress (personal data)", domain: "hr", dangerous: false },
  { key: "hr:write", name: "Manage HR pipeline", description: "Register applicants, change their status, record interview dates / notes and tick onboarding items", domain: "hr", dangerous: false },
  { key: "hr:admin", name: "Hire (add to roster) / delete applicants", description: "Mark an applicant as hired (adds them to the roster) and delete applicant records", domain: "hr", dangerous: true },
  { key: "app:hr:view", name: "Open 人事 app", description: "Open and view the 人事 app", domain: "app", dangerous: false },
  { key: "app:hr:edit", name: "Edit in 人事 app", description: "Act inside the 人事 app (implies view)", domain: "app", dangerous: false },
  { key: "sponsor:read", name: "Read sponsor business cards", description: "View business cards (photos and contact details) shared by the sponsor team", domain: "sponsor", dangerous: false },
  { key: "sponsor:write", name: "Share sponsor business cards", description: "Scan / register business cards and edit their contact details and notes", domain: "sponsor", dangerous: false },
  { key: "sponsor:admin", name: "Delete sponsor business cards", description: "Delete shared business cards (photo and contact details)", domain: "sponsor", dangerous: true },
  { key: "app:sponsor:view", name: "Open スポンサー app", description: "Open and view the スポンサー app", domain: "app", dangerous: false },
  { key: "app:sponsor:edit", name: "Edit in スポンサー app", description: "Act inside the スポンサー app (implies view)", domain: "app", dangerous: false },
  // 運営メンバーアプリの「範囲」(組織図まで / メール名簿以外 / 全て)。ロール管理では 3 段の選択肢として
  // 出す (policy.membersScopeOf)。鍵は積み上げ式で、mail ⇒ roster, edit ⇒ view (policy.normalizeAppAccessKeys)。
  { key: "members:roster_view", name: "View 運営名簿", description: "Open the 運営名簿 tab and read members' personal details (contact, student number, notes)", domain: "members", dangerous: false },
  { key: "members:roster_edit", name: "Edit 運営名簿", description: "Edit members' personal details and link login accounts (implies view)", domain: "members", dangerous: false },
  { key: "members:mail_view", name: "View メール名簿", description: "Open the メール名簿 tab (implies 運営名簿 view)", domain: "members", dangerous: false },
  { key: "members:mail_edit", name: "Edit メール名簿", description: "Required to change accounts in the メール名簿 tab, on top of ロール管理 edit + identity:admin (implies view)", domain: "members", dangerous: false },
  { key: "members:onboard_mail", name: "Issue accounts from 参加届", description: "From the 参加届 list, issue an @developershub.jp address and a login account for a person with no account yet (the server fixes the role to member; team/position roles then follow from the 名簿 as for any link), link it, and send the login info to their Gmail. Cannot change existing accounts or grant other roles", domain: "members", dangerous: true },
  { key: "goals:read", name: "Read team goals", description: "View every team's monthly goals, KPIs and progress", domain: "goals", dangerous: false },
  { key: "app:goals:view", name: "Open 目標管理 app", description: "Open and view the 目標管理 app", domain: "app", dangerous: false },
  { key: "app:goals:edit", name: "Edit in 目標管理 app", description: "Set and change team goals and KPIs (implies view)", domain: "app", dangerous: false },
  // 代理表示 (admin impersonation). Own domain so ロール管理 shows it under 「その他」 as its own
  // group (it is an org-wide capability, not part of the roster app's 詳細設定).
  { key: "identity:impersonate", name: "View the app as another member", description: "Start a short, audited impersonation session to see exactly what a member sees (admins cannot be impersonated)", domain: "impersonation", dangerous: true },
] as const satisfies readonly PermissionCatalogEntry[];

// Closed union of the 97 keys (open `${string}:${string}` template retired).
export type PermissionKey = (typeof PERMISSION_CATALOG)[number]["key"];

export type UserStatus = "active" | "invited" | "disabled" | "rejected";

export interface IdentityUser {
  id: UserId;
  orgId: OrgId;
  displayName: string;
  // 読み仮名（フリガナ）。任意・後方互換の加算フィールド（省略時は未設定）。
  // 五十音ソート / フリガナ検索に使う。表示名に振り仮名を添えるための表示専用属性。
  furigana?: string | null;
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
  furigana?: string; // 読み仮名（任意）
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
/** GET /internal/permission-holders — the catalog permission key to resolve holders for. */
export interface PermissionHoldersQuery {
  key: PermissionKey;
}

// ── Wire contract (query params) ─────────────────────────────────────────────
// SINGLE source of truth for the query-parameter *names* identity-roster's public
// (/identity/*) read endpoints put on the wire. The server (identity-roster app.ts) and
// the OpenAPI spec (docs/openapi/identity-roster.yaml) are reconciled against this map in
// CI (see @dub/e2e-smoke wire-params.test.ts). `roleKey` is intentionally listed as an
// accepted (deprecated) alias of `role` — the server reads both; canonical is `role`.
// The internal `/internal/users` route (not in the public spec) reads a subset of these
// same keys, so it needs no separate entry. `/internal/permission-holders` reads its own key
// (`key`), so it is listed. See docs/api-contracts/_wire-contract-enforcement.md.
export const IDENTITY_WIRE = {
  listOrgs: { method: "GET", path: "/identity/orgs", query: ["cursor", "limit"] },
  listUsers: {
    method: "GET",
    path: "/identity/users",
    query: ["cursor", "limit", "ids", "status", "role", "roleKey", "q"],
  },
  listRoles: { method: "GET", path: "/identity/roles", query: ["cursor", "limit"] },
  permissionHolders: { method: "GET", path: "/internal/permission-holders", query: ["key"] },
} as const;

// Compile-time tie: each endpoint's query keys must be real keys of its query type.
type _IdentityWireKeysAreTyped =
  (typeof IDENTITY_WIRE.listOrgs.query)[number] extends keyof ListOrgsQuery
    ? (typeof IDENTITY_WIRE.listUsers.query)[number] extends keyof ListUsersQuery
      ? (typeof IDENTITY_WIRE.listRoles.query)[number] extends keyof ListRolesQuery
        ? (typeof IDENTITY_WIRE.permissionHolders.query)[number] extends keyof PermissionHoldersQuery
          ? true
          : never
        : never
      : never
    : never;
const _identityWireKeyGuard: _IdentityWireKeysAreTyped = true;
void _identityWireKeyGuard;

// ---- 自動管理ロール (managed roles) ----------------------------------------------------
// 名簿 (member-service) のチーム・役職から自動で付くロール。identity-roster が実体
// (identity_roles / identity_role_assignments) を持ち、member-service が s2s で
// 「あるべき集合」を PUT する。手動の割当とは identity_role_assignments.source で区別し、
// 同期は source = AUTO_ASSIGNMENT_SOURCE の行だけを足し引きする (手動の割当には触らない)。

/** 自動管理ロールの id 接頭辞。これで始まる id だけを同期で作成・改名・削除できる。 */
export const MANAGED_ROLE_ID_PREFIX = "role_auto_";
/** 割当の由来。manual = 管理者が付けた / auto:member-sync = 名簿から自動で付いた。 */
export type RoleAssignmentSource = "manual" | "auto:member-sync";
export const AUTO_ASSIGNMENT_SOURCE: RoleAssignmentSource = "auto:member-sync";

/** 自動管理ロール 1 件 (id は MANAGED_ROLE_ID_PREFIX 始まり・権限は持たせない)。 */
export interface ManagedRoleSpec {
  id: RoleId;
  name: string;
}

/** PUT /internal/managed-roles — 自動管理ロールの一覧そのもの (チーム改名・削除の反映)。
 *  無いロールは作り、名前が違えば改名する。一覧に無い自動ロールは自動割当を外し、
 *  手動の割当も権限も無ければ削除する (あれば残す)。 */
export interface PutManagedRoleCatalogRequest {
  roles: ManagedRoleSpec[];
  dryRun?: boolean;
}
export interface PutManagedRoleCatalogResponse {
  dryRun: boolean;
  created: RoleId[];
  renamed: RoleId[];
  /** 削除したロール。 */
  deleted: RoleId[];
  /** 一覧から外れたが、手動の割当か権限があるので残したロール (自動割当だけ外す)。 */
  kept: RoleId[];
}

/** PUT /internal/users/:id/managed-roles — その人に付くべき自動ロールの集合。 */
export interface PutUserManagedRolesRequest {
  roles: ManagedRoleSpec[];
  dryRun?: boolean;
}
export interface PutUserManagedRolesResponse {
  dryRun: boolean;
  added: RoleId[];
  removed: RoleId[];
  /** 既に手動で付いているので自動では付けなかったロール (手動を優先)。 */
  manual: RoleId[];
}

/** POST /internal/users/:id/activate — 名簿 (member-service) が「在籍 (added) でこの
 *  アカウントに紐付いた」と確定した人の招待中アカウントを有効化する (invited -> active)。
 *  invited 以外 (active / disabled / rejected) には触れない (冪等・停止を上書きしない)。 */
export interface ActivateInvitedUserRequest {
  /** どの経路で有効化したか (監査用・例 "participation.link")。 */
  trigger: string;
  /** true なら書き込まず、有効化される予定かだけを返す。 */
  dryRun?: boolean;
}
export interface ActivateInvitedUserResponse {
  dryRun: boolean;
  /** invited -> active に変えた (dryRun なら変える予定)。 */
  activated: boolean;
  /** 呼び出し前の状態。 */
  previousStatus: UserStatus;
  /** 呼び出し後の状態 (dryRun なら previousStatus のまま)。 */
  status: UserStatus;
}
