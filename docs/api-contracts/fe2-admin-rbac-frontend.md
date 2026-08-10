# FE2 admin RBAC console — frontend consumption contract (申し送り)

Status: frontend delivered against a demo/mock transport. Real API is owned by
`services/identity-roster` (see [`identity-roster.md`](./identity-roster.md), the
source of truth) and the `auth-domain-roles` branch. This file is the **handoff**
from the FE2 admin console to that backend: the exact endpoints, request/response
shapes and status codes the console calls, so the real gateway can drop in with
no frontend change.

## Where the UI lives

- Console screens: `@dub/admin-roster` (FE7) — `RoleListPage`, `RoleEditorPage`
  (`PermissionMatrix`), `UserListPage` / `UserDetailPage` (`RoleAssignDialog`),
  `AuditHistoryPage`. Registered into the shell as the `admin` FeatureModule.
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

## Endpoints the console depends on

| # | Method & path | Permission | Request body | Success | Notes |
|---|---|---|---|---|---|
| ① perms | `GET /api/v1/identity/permissions/catalog` | `identity:read` | – | `PermissionCatalogEntry[]` (the 32 frozen keys) | Rendered by `PermissionMatrix`, grouped by `domain`, `dangerous` flagged. |
| ① edit | `PATCH /api/v1/identity/roles/:id` | `identity:admin` | `UpdateRoleRequest` `{ name?, permissions? }` (changed fields only) | `Role` | Save from `RoleEditorPage`. |
| ② add | `POST /api/v1/identity/roles` | `identity:admin` | `CreateRoleRequest` `{ name, permissions }` | `Role` (`isSystem:false`) | Name unique in org. |
| roles | `GET /api/v1/identity/roles` | `identity:read` | – | `Paginated<Role>` | Role list + member/perm counts. |
| del | `DELETE /api/v1/identity/roles/:id` | `identity:admin` | – | `204` | Blocked for system roles → `409`. |
| ③ assign | `POST /api/v1/identity/users/:id/roles` | `identity:admin` | `AssignRoleRequest` `{ roleId, resourceType?, resourceId? }` | `RoleAssignment` | Org-wide when resource fields omitted; `resourceType:"event"` for event-scope. |
| ③ list | `GET /api/v1/identity/users/:id/roles` | `identity:read` | – | `RoleAssignment[]` | Current assignments on the user detail screen. |
| ③ revoke | `DELETE /api/v1/identity/users/:id/roles/:assignmentId` | `identity:admin` | – | `204` | |
| users | `GET /api/v1/identity/users` | `identity:read` | `?ids=`, `?status=`, `?q=`, `?cursor=`, `?limit=` | `Paginated<IdentityUser>` | `?ids=` returns `UserSummary`-shaped rows for name resolution. |
| user | `GET /api/v1/identity/users/:id` | `identity:read` | – | `IdentityUserDetail` (`.permissions` = effective) | |
| invite | `POST /api/v1/identity/users/invite` | `identity:admin` | `InviteUserRequest` `{ email, displayName?, roleIds? }` | `IdentityUser` (`status:"invited"`) | |
| patch user | `PATCH /api/v1/identity/users/:id` | `identity:admin` | `Partial<IdentityUser>` `{ displayName?, status?, githubLogin? }` | `IdentityUser` | |
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
   `PATCH` on a role regardless of `isSystem` (only `DELETE` is blocked). The FE7
   editor deliberately renders **system roles read-only** (`RoleEditorPage`:
   `readOnly = isSystem || !can("identity:admin")`) and the demo mock returns
   `409` for a system-role `PATCH`, mirroring that UX. No behavior change needed
   backend-side — the UI simply never sends it for system roles.
2. **Effective permissions.** `IdentityUserDetail.permissions` must be the union
   of the user's role permissions (server-resolved). The demo computes this from
   the assigned roles; production resolves it in identity-roster.

## Not covered by this PR (backend to implement)

The real `/api/v1/identity/*` + `/api/v1/audit/logs` handlers behind the gateway,
authz enforcement, effective-permission resolution, and audit emission for the
five sync actions (`identity.role.assigned` / `.revoked`, `identity.user.provisioned`,
etc.). The frontend + demo already exercise the full request/response surface, so
wiring the real gateway is a transport swap (drop `VITE_DEMO`, point
`VITE_API_BASE_URL` at the gateway).
