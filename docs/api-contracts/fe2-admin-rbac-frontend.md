# FE2 admin RBAC console — frontend consumption contract (申し送り)

Status: frontend delivered against a demo/mock transport. Real API is owned by
`services/identity-roster` (see [`identity-roster.md`](./identity-roster.md), the
source of truth) and the `auth-domain-roles` branch. This file is the **handoff**
from the FE2 admin console to that backend: the exact endpoints, request/response
shapes and status codes the console calls, so the real gateway can drop in with
no frontend change.

## Where the UI lives

- Console screens: `@dub/admin-roster` (FE7) — `RoleListPage`, `RoleEditorPage`
  (`RolePolicyEditor`), `UserListPage` / `UserDetailPage` (`RoleAssignDialog`).
  Registered into the shell as the `admin` FeatureModule.
- Reached from the app-shell **AppLauncher** (`apps/fe2-app-shell`,
  `AppShellLayout`) as ロール管理 / ユーザー名簿 / 変更履歴 — shown **only** to viewers
  holding the route's `requiredPermissions` (admin-only; defense in depth on top
  of the per-route `RequirePermission` guard).
- Demo transport (backend-free showcase): `apps/fe2-app-shell/src/lib/demo-seed.tsx`
  `createRosterStore()` — an in-session stateful mock that serves every endpoint
  below so create/edit/assign persist within the page. Built with `VITE_DEMO=1`.

All paths are the gateway-external form `"/api/v1/identity/*"` (the console's
`ResourceClient` passes fully-qualified paths; the gateway strips `/api/v1`).
Every call requires an authenticated session; permissions are enforced by the
gateway/route AND surfaced by the UI's `can()`.

## Roles (the 3 agreed tiers)

`admin` / `maintainer` / `member` are system roles (`isSystem: true`,
`DELETE` blocked). Custom roles created via the console are `isSystem: false`.
The permission sets are seeded in `demo-seed.tsx`; the backend's `identity`
migration (`0002_system_roles.sql`) is authoritative in production.

## ロール管理 UI = the policy layer's 3 段階 (無効 / 閲覧 / 編集)

The console no longer edits ~60 flat permission toggles. It edits **one level per app**,
derived by the policy layer (`@dub/types` `policy`, the PDP) from the same catalog keys the
wire contract already carries — there is no new column, field or endpoint:

| Level | Meaning | Keys held |
|---|---|---|
| 無効 (`none`) | The app cannot be opened (launcher greys it, route guard 403s) | – |
| 閲覧 (`view`) | Can open and read; every create/edit/delete control is **disabled** | `app:<id>:view` |
| 編集 (`edit`) | Can create/update/delete inside the app (implies 閲覧) | `app:<id>:view` + `app:<id>:edit` |

Screen layout (`RolePolicyEditor`):

1. **一覧** — `AppAccessTable`: one row per app (`policy.appPolicyRows`, driven by
   `APP_MANIFEST`, so a newly registered app appears automatically) with a 3-way selector.
2. **詳細設定** — `AppDetailDialog`: clicking the app NAME opens everything that belongs to
   that app, in one place: the 3-way selector, its fine-grained keys
   (`APP_MANIFEST.detailPermissions`, e.g. chat の `chat:moderate`), and — as the dialog's
   BOTTOM section — that app's own workspace settings (`appSettingsPanels`, today chat の
   メッセージ削除ポリシー). Apps with no fine-grained key say so instead of showing an empty
   dialog; apps with no settings panel simply omit the bottom section.
3. **その他** — `OtherPermissionsSection`: keys no app owns (`policy.otherPermissions()` =
   the complement, so a future catalog key lands here rather than disappearing from the UI):
   ファイル / インフラ・デプロイ / 監査ログ / GitHub 連携 / Webhook. Rendered as one row per
   分類 (the same row→dialog interaction as the app table) so the screen stays two tables tall.

**Nothing app-specific sits at page level.** A card for one app directly on the ロール管理
screen (as the chat メッセージ削除ポリシー used to be) makes the top of the screen grow with every
app and hides which app it belongs to. The rule is: app-internal → that app's dialog (bottom
section); belongs to no app → the 「その他」 area at the very bottom.

`policy.setAppAccessLevel` only ever touches that app's two keys, so changing a level never
discards a 詳細設定. The write path normalises `edit ⇒ view` server-side
(`policy.normalizeAppAccessKeys` in identity-roster), so no client can persist an ambiguous
role. `PATCH` still sends the full `permissions` array (changed fields only) — unchanged.

### 閲覧 means buttons are dead (and the server agrees)

The tier is enforced on BOTH sides from the same module, so a disabled control and a 403 can
never disagree:

- Server (PEP): `@dub/auth-client` `requireAppAccess(app, level, { permission })`. Wired
  today on identity-roster's 管理 writes (`requireAdminEdit` — identity:admin **AND**
  `app:admin:edit`) and member-service's 運営メンバー / 参加届 writes.
- Client (display only): `useAppCapability(appId)` in the shell / `usePermissions().decide()`
  in FE7 → `readOnly` disables write affordances, `AppReadOnlyNotice` explains why.

## Endpoints the console depends on

| # | Method & path | Permission | Request body | Success | Notes |
|---|---|---|---|---|---|
| ① perms | `GET /api/v1/identity/permissions/catalog` | `identity:read` | – | `PermissionCatalogEntry[]` (the 61 frozen keys) | The console reads the frozen catalog from `@dub/types` for labels; this endpoint remains the server-side source. |
| ① edit | `PATCH /api/v1/identity/roles/:id` | `identity:admin` **+ 管理 app = 編集** | `UpdateRoleRequest` `{ name?, permissions? }` (changed fields only) | `Role` | Save from `RolePolicyEditor`. Server normalises `app:<id>:edit ⇒ app:<id>:view`. |
| ② add | `POST /api/v1/identity/roles` | `identity:admin` **+ 管理 app = 編集** | `CreateRoleRequest` `{ name, permissions }` | `Role` (`isSystem:false`) | Name unique in org. |
| roles | `GET /api/v1/identity/roles` | `identity:read` | – | `Paginated<Role>` | Role list + member/perm counts. Reads stay on `identity:read` (shared surface). |
| del | `DELETE /api/v1/identity/roles/:id` | `identity:admin` **+ 管理 app = 編集** | – | `204` | Blocked for system roles → `409`. |
| ③ assign | `POST /api/v1/identity/users/:id/roles` | `identity:admin` **+ 管理 app = 編集** | `AssignRoleRequest` `{ roleId, resourceType?, resourceId? }` | `RoleAssignment` | Org-wide when resource fields omitted; `resourceType:"event"` for event-scope. |
| ③ list | `GET /api/v1/identity/users/:id/roles` | `identity:read` | – | `RoleAssignment[]` | Current assignments on the user detail screen. |
| ③ revoke | `DELETE /api/v1/identity/users/:id/roles/:assignmentId` | `identity:admin` **+ 管理 app = 編集** | – | `204` | |
| users | `GET /api/v1/identity/users` | `identity:read` | `?ids=`, `?status=`, `?q=`, `?cursor=`, `?limit=` | `Paginated<IdentityUser>` | `?ids=` returns `UserSummary`-shaped rows for name resolution. |
| user | `GET /api/v1/identity/users/:id` | `identity:read` | – | `IdentityUserDetail` (`.permissions` = effective) | |
| invite | `POST /api/v1/identity/users/invite` | `identity:admin` **+ 管理 app = 編集** | `InviteUserRequest` `{ email, displayName?, roleIds? }` | `IdentityUser` (`status:"invited"`) | |
| patch user | `PATCH /api/v1/identity/users/:id` | `identity:admin` **+ 管理 app = 編集** | `Partial<IdentityUser>` `{ displayName?, status?, githubLogin? }` | `IdentityUser` | |
| history | `GET /api/v1/audit/logs` | `audit:read` | `?action=identity.` `?actorId=` `?since=` `?until=` `?cursor=` | `Paginated<AuditRecord>` | 変更履歴 tab shows `identity.*` actions only. |
| banner | `GET /api/v1/mail/status` | (any authed) | – | `{ service, provider, rateLimit }` | Admin header banner (mail-gateway rate-limit). |

Types are the frozen `@dub/types` `identity` namespace (`PermissionKey`, `Role`,
`IdentityUser`, `IdentityUserDetail`, `PermissionCatalogEntry`, `UserSummary`,
`InviteUserRequest`) plus the still-pending `CreateRoleRequest` /
`UpdateRoleRequest` / `AssignRoleRequest` / `RoleAssignment` (modeled in
`apps/fe7-admin-roster/src/contracts/pending.ts` until identity-roster publishes
them into `@dub/types`).

## Errors

Non-2xx must return the standard envelope `{ error: { code, message, retryable, details? } }`
(`@dub/errors`) so the console shows a meaningful toast. Codes the UI branches on:

- `400 VALIDATION_FAILED` — missing/invalid `name`, non-catalog permission key
  (`details[i] = { field: "permissions[i]", reason: "not_in_catalog" }`), bad
  invite email.
- `409 CONFLICT` — duplicate role name, duplicate assignment, delete of a system role.
- `404 NOT_FOUND` — unknown role/user.

## Two deliberate FE/contract divergences to note

1. **System role edit.** The backend contract (`identity-roster.md` §4.8) permits
   `PATCH` on a role regardless of `isSystem` (only `DELETE` is blocked). FE7 now allows it
   too (admins edit system roles in place); only the role NAME stays frozen for a system
   role, and the built-in `admin` role keeps `identity:admin` + the 管理 app at 編集 pinned
   (`lockedKeysForRole`, self-lockout guard). A 403-worthy write is never offered: the Save
   button is gated on the same policy requirement the server checks.
2. **Effective permissions.** `IdentityUserDetail.permissions` must be the union
   of the user's role permissions (server-resolved). The demo computes this from
   the assigned roles; production resolves it in identity-roster.

## Email Routing tab (メールアドレス管理)

A second admin tool in the same console: manage the org's `@developershub.jp`
addresses backed by **Cloudflare Email Routing** (each managed address = one
Email Routing rule forwarding `localPart@developershub.jp` → the mail Worker).
Reached from the launcher, **gated on `mail:admin`** (admin + maintainer hold it
in the demo). UI: `EmailRoutingPage` + `NewEmailAddressDialog` (FE7). Backend is
the separate Email Routing proxy service.

| Action | Method & path | Permission | Request | Success | Errors |
|---|---|---|---|---|---|
| list | `GET /api/v1/admin/email-routing/addresses` | `mail:admin` | – | `Paginated<EmailRoutingAddress>` | – |
| issue | `POST /api/v1/admin/email-routing/addresses` | `mail:admin` | `{ localPart }` (`destination` optional/ignored — fixed to the mail Worker server-side) | `EmailRoutingAddress` (`enabled:true`) | `400` bad localPart (`^[a-z0-9._-]+$`); `409` duplicate localPart |
| enable/disable · repoint | `PATCH /api/v1/admin/email-routing/addresses/:id` | `mail:admin` | `{ enabled?, destination? }` | `EmailRoutingAddress` | `400` bad destination; `404` |
| delete | `DELETE /api/v1/admin/email-routing/addresses/:id` | `mail:admin` | – | `204` | `404` |

```ts
interface EmailRoutingAddress {
  id: string;          // Email Routing rule id
  localPart: string;   // "info"
  address: string;     // "info@developershub.jp" (server-derived)
  destination: string; // forward-to address
  enabled: boolean;    // rule enabled / paused
  createdAt: string;   // ISO8601
}
```

The org domain is fixed (`developershub.jp`); only the local part is client-set.
Types are modeled in `apps/fe7-admin-roster/src/contracts/pending.ts`
(`EmailRoutingAddress` / `CreateEmailAddressRequest` / `UpdateEmailAddressRequest`,
`EMAIL_ROUTING_DOMAIN`) until the proxy service publishes them. The example
paths the coordinator named (`/api/v1/admin/email-routing/addresses` and `/rules`)
map to this surface — addresses are the primary resource; a "rule" is the
Cloudflare object each address corresponds to.

## Not covered by this PR (backend to implement)

The real `/api/v1/identity/*` + `/api/v1/audit/logs` handlers behind the gateway,
authz enforcement, effective-permission resolution, and audit emission for the
five sync actions (`identity.role.assigned` / `.revoked`, `identity.user.provisioned`,
etc.). The frontend + demo already exercise the full request/response surface, so
wiring the real gateway is a transport swap (drop `VITE_DEMO`, point
`VITE_API_BASE_URL` at the gateway).
