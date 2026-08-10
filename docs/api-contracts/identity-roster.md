# API Contract — identity-roster

Identity / roster source of truth for the Dub ecosystem: orgs, users, roles, role
assignments, the frozen permission catalog, effective-permission resolution, and
the RBAC `authz/check` used by every other service (through `@dub/auth-client`).

This document is the wire contract for the service's HTTP surface. It is bound by
the ecosystem-wide rules in [`_conventions.md`](./_conventions.md) and
[`auth.md`](./auth.md); anything those files state (envelope shapes, header
propagation, pagination, error wire form, idempotency) applies here and is not
restated. Types referenced below live in `@dub/types` (`identity`, `common`,
`auditLog`) and `@dub/errors` (`ErrorResponse`).

- Service package: `@dub/identity-roster` (Cloudflare Worker + Hono)
- Source of truth read while writing this contract: `services/identity-roster/src/{app,service,dto,authz,permissions}.ts`, `packages/types/src/{identity,common}.ts`, `packages/errors/src/wire.ts`
- `CONTRACT_VERSION`: `1.0.0` (P0b freeze)

---

## 1. Surface model

There are two disjoint surfaces, and the split is a security boundary
("double-defence"), not merely a naming convention.

| Surface | Route prefix | Reachable via | Auth gate | Callers |
|---|---|---|---|---|
| External | `/identity/*` | api-gateway (`/api/v1/identity/*`, prefix stripped) | `x-dub-user-id` present **and** the route's permission | FE7 admin roster, FE app-shell, MO3 BFF |
| Internal | `/users/provision`, `/authz/check`, `/internal/*` | Service Binding only | `x-dub-internal: 1` (presence-only in P0) | auth-service, `@dub/auth-client` in every service |

**Double-defence.** The gateway routes only `/api/v1/*` and never exposes the
internal paths, so an external client hitting `/authz/check` gets a gateway
`404` (first line). Even if a request reaches the Worker, the internal routes
reject anything without `x-dub-internal: 1` with `403 FORBIDDEN` (second line).
External clients therefore cannot reach `authz/check`, `provision`, or
`internal/*` under any circumstance.

**Org scoping.** External routes operate against a single implicit org — the
Worker's configured `DUB_DEFAULT_ORG_ID` (`"org_devhub"` in P0). Clients do not
pass an org id on external routes. `/authz/check` is the exception: it is
multi-org-capable and takes `orgId` in the body.

### 1.1 Request context headers (set by the gateway / caller)

| Header | Meaning | Who sets it |
|---|---|---|
| `x-dub-request-id` | Correlation id; echoed into `ErrorResponse.error.requestId` and audit records. Generated as a fallback if absent. | gateway / originating service |
| `x-dub-user-id` | Trusted subject id, verified once at the entrypoint. The identity of the actor for all external routes. | gateway (after token verification) |
| `x-dub-internal` | Presence-only marker `"1"`. Required by every internal route. | calling service (Service Binding) |

Note (theme6): `x-dub-org-id` and `x-dub-roles` were **removed** from the wire.
Authorization is resolved centrally here via `authz/check`; downstream services
never trust caller-supplied roles.

### 1.2 Authentication / authorization failures

| Condition | Code | HTTP |
|---|---|---|
| External route without `x-dub-user-id` | `AUTH_INVALID_TOKEN` | 401 |
| External route, user lacks the required permission | `FORBIDDEN` | 403 |
| Internal route without `x-dub-internal: 1` | `FORBIDDEN` | 403 |

---

## 2. Error wire form

Every error is the standard `@dub/errors` `ErrorResponse` (see `_conventions.md`):

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "unknown permission key(s)",
    "details": [{ "field": "permissions[1]", "reason": "not_in_catalog", "message": "task:bogus" }],
    "requestId": "req_01J...",
    "service": "identity-roster",
    "retryable": false
  }
}
```

Common codes used by this service: `VALIDATION_FAILED` (400), `AUTH_INVALID_TOKEN`
(401), `FORBIDDEN` (403), `NOT_FOUND` (404), `CONFLICT` (409). Conflicts carry a
service-specific discriminator in a machine-readable `code` on the thrown error
(surfaced in `message`); the documented discriminators are: `EMAIL_EXISTS`,
`USER_NOT_INVITED`, `ROLE_NAME_EXISTS`, `SYSTEM_ROLE`, `ASSIGNMENT_EXISTS`,
`LAST_ADMIN`.

---

## 3. RBAC semantics (frozen)

Evaluation is **default-deny**. A single check `{ permission, resourceType?, resourceId? }`
is **allowed** iff all hold:

1. The subject user exists, `status === "active"`, and is a member of the target org.
2. `permission` is one of the 32 frozen catalog keys (`identity.PERMISSION_CATALOG`). Non-catalog keys are always denied.
3. The user has at least one role assignment in that org whose role grants `permission`, and that assignment is **org-wide** (`resourceType`/`resourceId` both null) **or** exactly matches the query's `resourceType` + `resourceId`.

An org-wide grant satisfies both org-wide and resource-scoped queries; a
resource-scoped grant satisfies only the exact matching resource. P0 supports at
most one resource scope dimension (`"event"`); task-level scoping is P1.

Effective-permission responses (`IdentityUserDetail.permissions`, `/internal/users/:id/permissions`)
expose the **org-wide** set only. Resource-scoped grants stay server-side and are
observable only through `authz/check`.

---

## 4. External endpoints (`/identity/*`)

Public base path via gateway: `/api/v1/identity`. Every route requires
`x-dub-user-id`. The "Permission" column is the org-wide permission the caller
must hold.

### 4.1 `GET /identity/orgs`

List orgs. Permission: `identity:read`.

Query: `limit` (default 50, max 200), `cursor` (opaque).

Response `200` — `common.Paginated<identity.Org>`:

```json
{
  "items": [
    { "id": "org_devhub", "name": "DevHub", "createdAt": "2026-08-09T05:00:00Z" }
  ],
  "nextCursor": null
}
```

### 4.2 `GET /identity/users`

List roster users in the org. Permission: `identity:read`.

Query parameters:

| Param | Type | Notes |
|---|---|---|
| `ids` | comma-separated | Batch fetch (max 50). **Exclusive** with `status`/`cursor`. |
| `status` | `active` \| `invited` \| `disabled` \| `rejected` | Filter. |
| `limit` | number | Default 50, max 200. |
| `cursor` | string | Opaque; from a prior `nextCursor`. |

`ids` combined with `status` or `cursor` → `400 VALIDATION_FAILED`
(`{ field: "ids", reason: "exclusive" }`). `ids` longer than 50 →
`400 VALIDATION_FAILED` (`reason: "too_long"`).

Response `200` — `common.Paginated<identity.IdentityUser>`:

```json
{
  "items": [
    {
      "id": "user_01J...",
      "orgId": "org_devhub",
      "displayName": "Kota",
      "email": "kota@example.com",
      "githubLogin": "ko-tarou",
      "avatarUrl": null,
      "status": "active",
      "roleIds": ["role_admin"],
      "createdAt": "2026-08-09T05:00:00Z",
      "updatedAt": "2026-08-09T05:00:00Z"
    }
  ],
  "nextCursor": null
}
```

`roleIds` lists only the user's **org-wide** role assignments.

### 4.3 `GET /identity/users/:id`

Fetch one user with resolved org-wide permissions. Permission: **self-read is
always allowed**; reading another user requires `identity:read`.

Response `200` — `identity.IdentityUserDetail` (`IdentityUser` + `permissions`):

```json
{
  "id": "user_01J...",
  "orgId": "org_devhub",
  "displayName": "Kota",
  "email": "kota@example.com",
  "githubLogin": "ko-tarou",
  "avatarUrl": null,
  "status": "active",
  "roleIds": ["role_admin"],
  "permissions": ["identity:read", "identity:admin", "event:read", "event:write"],
  "createdAt": "2026-08-09T05:00:00Z",
  "updatedAt": "2026-08-09T05:00:00Z"
}
```

Unknown id → `404 NOT_FOUND`. Reading another user without `identity:read` →
`403 FORBIDDEN`.

### 4.4 `POST /identity/users/invite`

Invite a user onto the roster (invite-only model). Permission: `identity:admin`.

Request — `identity.InviteUserRequest`:

```json
{
  "email": "new@example.com",
  "displayName": "New Member",
  "roleIds": ["role_member"]
}
```

`email` is required and normalized (trimmed, lowercased). `displayName` defaults
to the email local-part. `roleIds` are optional org-wide grants; each must be a
role in the org.

Response `201`:

```json
{
  "user": {
    "id": "user_01J...",
    "orgId": "org_devhub",
    "displayName": "New Member",
    "email": "new@example.com",
    "githubLogin": null,
    "avatarUrl": null,
    "status": "invited",
    "roleIds": ["role_member"],
    "createdAt": "2026-08-10T00:00:00Z",
    "updatedAt": "2026-08-10T00:00:00Z"
  }
}
```

Errors: invalid email → `400 VALIDATION_FAILED`; org missing → `404 NOT_FOUND`;
email already on the roster → `409 CONFLICT` (`EMAIL_EXISTS`); unknown role id →
`400 VALIDATION_FAILED` (`reason: "unknown_role"`).

Emits audit `identity.user.invited`.

### 4.5 `PATCH /identity/users/:id`

Update a user's profile or status. Permission: `identity:admin`.

Request — `dto.UpdateUserRequest` (all fields optional):

```json
{
  "displayName": "Renamed",
  "githubLogin": "ko-tarou",
  "status": "disabled"
}
```

`status` set to a non-`active` value on a currently-active user triggers a
**session revoke** for that user before the status change (fail-closed: if the
revoke fails, the status is not changed). `githubLogin` may be `null` to clear.

**Last-admin guard:** disabling the org's only remaining active `identity:admin`
holder → `409 CONFLICT` (`LAST_ADMIN`).

Response `200` — the updated `identity.IdentityUser`. Unknown id / wrong org →
`404 NOT_FOUND`. Emits audit `identity.user.updated`.

### 4.6 `GET /identity/roles`

List roles in the org. Permission: `identity:read`.

Query: `limit`, `cursor`. Response `200` — `common.Paginated<identity.Role>`:

```json
{
  "items": [
    { "id": "role_admin", "orgId": "org_devhub", "name": "admin", "permissions": ["identity:read", "identity:admin"], "isSystem": true }
  ],
  "nextCursor": null
}
```

### 4.7 `POST /identity/roles`

Create a custom role. Permission: `identity:admin`.

Request — `dto.CreateRoleRequest`:

```json
{
  "name": "organizer",
  "permissions": ["event:read", "event:write", "event:admin"]
}
```

`name` required and unique within the org. `permissions` must all be catalog
keys; duplicates are de-duplicated server-side.

Response `201` — the created `identity.Role` (`isSystem: false`). Errors: empty
name → `400 VALIDATION_FAILED`; non-catalog key → `400 VALIDATION_FAILED`
(`reason: "not_in_catalog"`, one `FieldError` per bad key at `permissions[i]`);
org missing → `404 NOT_FOUND`; duplicate name → `409 CONFLICT`
(`ROLE_NAME_EXISTS`). Emits audit `identity.role.created`.

### 4.8 `PATCH /identity/roles/:id`

Rename a role and/or replace its permission set. Permission: `identity:admin`.

Request — `dto.UpdateRoleRequest` (both optional; `permissions` **replaces**, not merges):

```json
{ "name": "lead-organizer", "permissions": ["event:read", "event:write"] }
```

Response `200` — the updated `identity.Role`. Unknown id / wrong org →
`404 NOT_FOUND`; non-catalog key → `400 VALIDATION_FAILED`; name clash →
`409 CONFLICT` (`ROLE_NAME_EXISTS`). Emits audit `identity.role.updated`.

> System roles: the contract permits `PATCH` on a role regardless of `isSystem`.
> Only `DELETE` is blocked for system roles (§4.9).

### 4.9 `DELETE /identity/roles/:id`

Delete a custom role. Permission: `identity:admin`.

Response `204` (no body). Unknown id / wrong org → `404 NOT_FOUND`; the role has
`isSystem: true` → `409 CONFLICT` (`SYSTEM_ROLE`). Emits audit
`identity.role.deleted`.

### 4.10 `POST /identity/users/:id/roles`

Grant a role to a user, org-wide or resource-scoped. Permission: `identity:admin`.

Request — `dto.AssignRoleRequest`:

```json
{ "roleId": "role_organizer", "resourceType": "event", "resourceId": "evt_01J..." }
```

`resourceType` and `resourceId` must be supplied **together** or both omitted
(omitted = org-wide grant). P0 resource scope: `"event"`.

Response `201`:

```json
{ "assignmentId": "ra_01J..." }
```

Errors: unknown user or role (or cross-org) → `404 NOT_FOUND`; only one of
`resourceType`/`resourceId` present → `400 VALIDATION_FAILED`
(`reason: "scope_incomplete"`); identical assignment already exists →
`409 CONFLICT` (`ASSIGNMENT_EXISTS`).

Emits audit `identity.role.assigned` (a **synchronous / write-ahead** audit —
logged before the assignment is persisted, fail-closed).

### 4.11 `DELETE /identity/users/:id/roles/:assignmentId`

Revoke a role assignment. Permission: `identity:admin`.

Response `204` (no body). Unknown assignment, or one not belonging to `:id` in
this org → `404 NOT_FOUND`.

**Last-admin guard:** revoking the org's only remaining org-wide `identity:admin`
grant (when it is this user's sole such grant) → `409 CONFLICT` (`LAST_ADMIN`).

Emits audit `identity.role.revoked` (synchronous / write-ahead, fail-closed).

### 4.12 `GET /identity/permissions/catalog`

Return the frozen permission catalog (FE7 renders it). Permission: `identity:read`.

Response `200` — `readonly identity.PermissionCatalogEntry[]` (32 entries):

```json
[
  { "key": "identity:read", "name": "Read roster", "description": "View roster, roles and the permission catalog", "domain": "identity", "dangerous": false },
  { "key": "identity:admin", "name": "Administer identity", "description": "Update users, invite, role CRUD, grant/revoke", "domain": "identity", "dangerous": true }
]
```

The catalog is closed: adding a key is a contract change. `dangerous: true` keys
drive the FE7 warning UI and force an always-synchronous authz check in
`@dub/auth-client`.

---

## 5. Internal endpoints (`x-dub-internal: 1`)

Not exposed through the gateway. Each requires `x-dub-internal: 1`; missing →
`403 FORBIDDEN`. These carry no per-user permission gate — the internal marker is
the authorization (trusted Service Binding caller).

### 5.1 `POST /users/provision`

Called by auth-service on first sign-in to transition an invited user to active
(invite-only). Not idempotency-key based but **idempotent by status**.

Request — `identity.ProvisionUserRequest`:

```json
{ "email": "member@example.com", "displayName": "Member", "githubLogin": "member-gh" }
```

Response `200` — `dto.ProvisionUserResponse`. `status` is one of:

| `status` | Meaning | `user` |
|---|---|---|
| `provisioned` | Was `invited`, now transitioned to `active`. | the active user |
| `existing` | Already `active`; idempotent no-op. | the active user |
| `rejected` | Not on the invite roster; no row created. Auth-service maps this to `403`. | `null` |

```json
{
  "status": "provisioned",
  "user": {
    "id": "user_01J...", "orgId": "org_devhub", "displayName": "Member",
    "email": "member@example.com", "githubLogin": "member-gh", "avatarUrl": null,
    "status": "active", "roleIds": [],
    "createdAt": "2026-08-09T05:00:00Z", "updatedAt": "2026-08-10T00:00:00Z"
  }
}
```

A user in `rejected` or `disabled` status → `409 CONFLICT` (`USER_NOT_INVITED`).
Invalid email → `400 VALIDATION_FAILED`. Emits audit `identity.user.provisioned`
(a `provisioned` transition uses a write-ahead sync audit).

### 5.2 `POST /authz/check`

The RBAC decision endpoint. This is the hot path `@dub/auth-client` calls for
every downstream authorization. Batched (1..20 checks) and multi-org-capable.

Request — `identity.AuthzCheckRequest`:

```json
{
  "subjectUserId": "user_01J...",
  "orgId": "org_devhub",
  "checks": [
    { "permission": "event:write" },
    { "permission": "event:admin", "resourceType": "event", "resourceId": "evt_01J..." }
  ]
}
```

`subjectUserId` and `orgId` are required strings. `checks` must have length
`1..20`.

Response `200` — `identity.AuthzCheckResponse`. `decisions` is **positional** —
one per input check, in the same order:

```json
{
  "decisions": [
    { "allowed": true,  "evaluatedAt": "2026-08-10T00:00:00Z", "ttlSeconds": 60 },
    { "allowed": false, "evaluatedAt": "2026-08-10T00:00:00Z", "ttlSeconds": 60 }
  ]
}
```

`ttlSeconds` (60) is the server-specified cache lifetime the client honors.
Evaluation follows §3 (default-deny; inactive/cross-org subject → all `false`;
non-catalog key → `false`). Missing `subjectUserId`/`orgId` → `400 VALIDATION_FAILED`;
`checks` empty or > 20 → `400 VALIDATION_FAILED` (`field: "checks"`).

### 5.3 `GET /internal/users/:id/permissions`

Return a subject's resolved **org-wide** permission set (for the configured org).
Used by shells/BFFs that need the whole set rather than per-permission checks.

Response `200` — `dto.EffectivePermissionsResponse`:

```json
{
  "userId": "user_01J...",
  "orgId": "org_devhub",
  "permissions": ["identity:read", "event:read", "event:write"]
}
```

An inactive or non-member subject yields `permissions: []` (not a 404).
Resource-scoped grants are intentionally excluded (resolve those via §5.2).

---

## 6. Health

### `GET /health`

Unauthenticated liveness probe. Response `200`:

```json
{ "ok": true, "service": "identity-roster" }
```

---

## 7. Audit actions emitted

| Action | Emitted by | Mode |
|---|---|---|
| `identity.user.invited` | §4.4 | async |
| `identity.user.updated` | §4.5 | async |
| `identity.user.provisioned` | §5.1 (`success`/`denied`) | write-ahead sync on transition |
| `identity.role.created` | §4.7 | async |
| `identity.role.updated` | §4.8 | async |
| `identity.role.deleted` | §4.9 | async |
| `identity.role.assigned` | §4.10 | write-ahead sync |
| `identity.role.revoked` | §4.11 | write-ahead sync |

Records use `auditLog.AuditRecordInput` (`action`, `actorId`, `orgId`, `result`,
`resourceType`, `resourceId`, `details`, `requestId`, `occurredAt`). The
assignment / provision paths use the synchronous (write-ahead, fail-closed) sink
so an audit-write failure aborts the mutation.

---

## 8. Notes for consumers

- **`@dub/auth-client`** is the only sanctioned way to call `/authz/check`; do not hand-roll it. It caches by `ttlSeconds`, always re-checks `dangerous` permissions, and fails closed.
- External callers never send an org id; the org is implicit. Only `/authz/check` takes `orgId`.
- `permissions` in user/effective responses are org-wide; a `false` from a resource-scoped page action does not contradict an absent key in the effective set — check the specific resource via `/authz/check`.
- Pagination, cursors (`limit` default 50 / max 200), and the error envelope are governed by [`_conventions.md`](./_conventions.md).
