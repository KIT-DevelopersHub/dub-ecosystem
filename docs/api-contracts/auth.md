# Dub Auth & Authz Contract

Status: Foundation contract (v1) — **highest-priority topsoil**. Every component's
login state, session handling, and permission gating depends on this. Read
[`_conventions.md`](./_conventions.md) first for the shared envelope, headers, and codes.

**Source of truth (code):**

| Concern | Code |
|---|---|
| Auth request/response types | `packages/types/src/auth.ts` |
| Permission catalog + authz types | `packages/types/src/identity.ts` |
| `GET /api/v1/me` (gateway) shape | `packages/types/src/gateway.ts` (`MeResponse`) |
| auth-service routes | `services/auth-service/src/app.ts` |
| Session lifecycle (KV) | `services/auth-service/src/sessions.ts` |
| authn/authz client helpers | `packages/auth-client/src/index.ts` |

---

## 1. Model in one paragraph

Login is **Google OAuth 2.0 (PKCE), invite-only** — there is no password endpoint.
A successful login mints an **opaque, KV-backed session token** (not a JWT). The **web**
client carries it in an `HttpOnly` cookie (`dub_session`); the **mobile** client carries
it as a **Bearer** token. Downstream services never see the token: the two entrypoints
(`api-gateway`, `mo3-mobile-bff`) verify it once via auth-service `/verify` and forward
the trusted `x-dub-user-id` header. **Authorization** is a separate concern, resolved per
request against identity-roster `/authz/check` against a frozen 32-key permission catalog.

Two token transports, one session model:

| Client | Transport | Absolute lifetime | Access TTL |
|---|---|---|---|
| web | `dub_session` cookie (`HttpOnly; Secure; SameSite=Lax; Domain=.developershub.jp; Path=/`) | 30 days | 3600 s |
| mobile | `Authorization: Bearer <token>` | 180 days | 3600 s |

`sessionExpiresAt` fields are **epoch-ms `number`** (the one time exception, §_conventions 6.2).

---

## 2. Endpoint map

Public web endpoints are reached **through the gateway**, so every web path below is
served under the gateway prefix `/api/v1` (`common.API_PREFIX`). The `/api/v1/auth/*`
routes proxy 1:1 to auth-service (prefix stripped); **`GET /api/v1/me` is gateway-owned**
(it composes session + permissions) — it is **not** an `/auth/*` route and has no
auth-service counterpart. `GET /auth/callback` is registered on auth-service's own public
hostname because Google redirects to it directly, not through the gateway.

| Method & path (external) | Exposed on | Auth | Purpose |
|---|---|---|---|
| `POST /api/v1/auth/login` | gateway -> auth-service | none | Begin OAuth; returns the Google `authorizationUrl` |
| `GET /auth/callback` | auth-service (public) | none | OAuth redirect target; sets cookie, 302s back to the SPA |
| `POST /api/v1/auth/refresh` | gateway -> auth-service | cookie or bearer | Slide the session; rotate token |
| `POST /api/v1/auth/logout` | gateway -> auth-service | cookie or bearer | Revoke the current session |
| `GET /api/v1/me` | **gateway (owned)** | cookie or bearer | Current user + org + effective permissions |
| `POST /mobile/exchange` | auth-service (internal, MO3 only) | `x-dub-internal` | Exchange a mobile OAuth code for a bearer token |
| `POST /verify` | auth-service (internal, gateway/BFF only) | `x-dub-internal` | Verify a token -> session (used by entrypoints) |
| `POST /authz/check` | identity-roster (internal) | `x-dub-internal` | Batch permission decisions |
| `POST /api/v1/auth/test-login` | gateway -> auth-service (**local/preview only**) | none | Mint a session for a user id without OAuth |

Internal-only routes reject any request lacking `x-dub-internal: 1` with
`AUTH_INTERNAL_FORBIDDEN` (403). `test-login` is compiled out of production builds (theme8).

---

## 3. Login (OAuth start)

### `POST /auth/login`

Request (`auth.AuthLoginStartRequest`):

```json
{
  "redirectUri": "https://app.developershub.jp/home",
  "client": "web"
}
```

- `redirectUri` (required) — where to land in the SPA after callback. Must match the
  server redirect allowlist, else `VALIDATION_FAILED` with `{ "field": "redirectUri", "reason": "not_allowed" }`.
- `client` (optional) — `"web"` (default) or `"mobile"`.

Response `200`:

```json
{
  "authorizationUrl": "https://accounts.google.com/o/oauth2/v2/auth?client_id=...&code_challenge=...&state=8f3c...",
  "state": "8f3c2a1b9d..."
}
```

The browser navigates to `authorizationUrl`. `state` and the PKCE verifier are held
server-side in KV (single-use, `stateTtlSec` = 600 s).

### `GET /auth/callback?code=...&state=...`

Google redirects here. This endpoint **always 302s, never returns JSON errors** — on
failure it redirects to the SPA error URL with `?error=<CODE>`.

Success: sets the session cookie and 302s to the original `redirectUri`.

```
HTTP/1.1 302 Found
Set-Cookie: dub_session=<opaque-token>; HttpOnly; Secure; SameSite=Lax; Domain=.developershub.jp; Path=/; Max-Age=2592000
Location: https://app.developershub.jp/home
```

Failure:

```
HTTP/1.1 302 Found
Location: https://app.developershub.jp/auth/error?error=AUTH_STATE_MISMATCH
```

Failure `error` codes include `AUTH_STATE_MISMATCH`, `AUTH_OAUTH_EXCHANGE_FAILED`,
`AUTH_USER_REJECTED` (email not invited — invite-only provisioning).

### Mobile login: `POST /mobile/exchange` (internal, MO3 only)

The native app runs the Google OAuth flow, then hands MO3 the authorization `code`; MO3
calls this internal route.

Request (`auth.MobileExchangeRequest`): `{ "code": "4/0Ax..." }`

Response `200` (`{ token, session }`):

```json
{
  "token": "dst_01J9Z8Q0X7M3K2P5R8T1V4W6Y9....",
  "session": { "userId": "user_01J9Z...", "client": "mobile", "sessionExpiresAt": 1760000000000 }
}
```

The app stores `token` in the secure keychain and sends it as `Authorization: Bearer`.

---

## 4. Session shape

`auth.SessionInfo` — the only session object that crosses the wire:

```json
{
  "userId": "user_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "client": "web",
  "sessionExpiresAt": 1760000000000
}
```

| Field | Type | Meaning |
|---|---|---|
| `userId` | string (prefix-ULID) | Session subject |
| `client` | `"web" \| "mobile"` | Token transport class |
| `sessionExpiresAt` | number (**epoch-ms**) | Access-token expiry; refresh before this to slide the session |

The token itself is **opaque** — an internal KV-backed identifier, not a JWT. Clients must
not parse it. Internally auth-service keeps richer bookkeeping (`issuedAt`,
`accessExpiresAt`, `absoluteExpiresAt`) that never leaves the service.

---

## 5. Who am I: `GET /api/v1/me`

Gateway-owned (registered directly on the gateway, **not** proxied to auth-service and
**not** an `/auth/*` path). It verifies the session and composes the identity permission
set. Response is `gateway.MeResponse`:

```json
{
  "user": {
    "id": "user_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
    "displayName": "Kotaro Takaoka",
    "avatarUrl": "https://.../avatar.png"
  },
  "orgId": "org_devhub",
  "permissions": ["identity:read", "event:read", "task:read", "task:write", "notif:inbox:self"],
  "sessionExpiresAt": 1760000000000
}
```

| Field | Type | Meaning |
|---|---|---|
| `user` | `identity.UserSummary` | id, displayName, avatarUrl |
| `orgId` | string | Active org (`org_devhub`) |
| `permissions` | `PermissionKey[]` | **Effective** permissions resolved from the user's roles — the FE gates UI on this list |
| `sessionExpiresAt` | number (epoch-ms) | Access-token expiry |

Unauthenticated call -> `401 UNAUTHENTICATED`. The FE treats 401 on `/api/v1/me` as
"logged out" and routes to login.

---

## 6. Refresh

### `POST /auth/refresh`

Slides the session and rotates the token. Two paths, chosen by how the token arrives:

- **cookie path** (web): token read from the `dub_session` cookie; a fresh cookie is set.
- **bearer path** (mobile): token from `Authorization: Bearer` (or `{ "refreshToken": "..." }`
  body); the new token is returned in the JSON body.

Request (`auth.AuthRefreshRequest`, body optional):

```json
{ "refreshToken": "dst_01J9Z..." }
```

Response — cookie path (`{ session }` + `Set-Cookie`):

```json
{ "session": { "userId": "user_01J9Z...", "client": "web", "sessionExpiresAt": 1760003600000 } }
```

Response — bearer path (`{ token, session }`):

```json
{
  "token": "dst_01J9Z...NEW",
  "session": { "userId": "user_01J9Z...", "client": "mobile", "sessionExpiresAt": 1760003600000 }
}
```

Errors:

| Situation | Code | HTTP |
|---|---|---|
| Token malformed / unparseable | `AUTH_INVALID_TOKEN` | 401 |
| Session revoked / past absolute lifetime | `AUTH_SESSION_REVOKED` | 401 |

---

## 7. Logout

### `POST /auth/logout`

Revokes the current session. Cookie path clears the cookie; bearer path just invalidates
the token server-side. Idempotent — returns `200 { "ok": true }` even if the token was
already invalid.

Response `200`:

```json
{ "ok": true }
```

Cookie path also returns:

```
Set-Cookie: dub_session=; HttpOnly; Secure; SameSite=Lax; Domain=.developershub.jp; Path=/; Max-Age=0
```

### Admin revoke: `POST /internal/revoke-user` (internal, identity only)

identity-roster calls this to kill **all** of a user's sessions (e.g. on disable). Body
`{ "userId": "...", "reason": "..." }` -> `200 { "ok": true }`. After this, that user's
tokens fail `/verify` with reason `revoked`.

---

## 8. Verify (internal — how entrypoints authenticate)

### `POST /verify` (auth-service, internal only)

Called by the gateway / BFF on each request to turn a token into a session. Not for
component authors, but part of the contract because it defines authn semantics.

Request (`auth.AuthVerifyRequest`): `{ "token": "dst_01J9Z..." }`

Response (`auth.AuthVerifyResponse`):

```json
{
  "valid": true,
  "userId": "user_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "session": { "userId": "user_01J9Z...", "client": "web", "sessionExpiresAt": 1760000000000 },
  "reason": null
}
```

Invalid:

```json
{ "valid": false, "userId": null, "session": null, "reason": "expired" }
```

`reason` (non-null only when `valid=false`) is one of `"malformed" | "expired" | "revoked"`.
The entrypoint maps these to `401` errors: `AUTH_INVALID_TOKEN` / `AUTH_SESSION_EXPIRED` /
`AUTH_SESSION_REVOKED`.

---

## 9. Authorization — permission catalog

Authorization is **never** carried in a header or the token. It is resolved per request by
querying identity-roster, keyed by a **frozen 32-key permission catalog**
(`identity.PERMISSION_CATALOG`). Adding a key is a contract change (theme2).

### 9.1 Key shape

`<domain>:<action>`, lowercase, no wildcards, **default-deny** for any unknown key.
Self-service keys carry a `:self` scope segment. Every entry declares `dangerous`
(FE7 shows a warning; the auth-client always re-checks dangerous keys fresh, never cached).

### 9.2 Catalog by domain (32 keys)

| Domain | Keys (⚠ = dangerous) |
|---|---|
| identity | `identity:read`, `identity:admin` ⚠ |
| event | `event:read`, `event:write`, `event:admin` ⚠ |
| task | `task:read`, `task:write`, `task:delete` |
| file | `file:read`, `file:write`, `file:admin` ⚠ |
| notif | `notif:send`, `notif:admin`, `notif:inbox:self`, `notif:prefs:self` |
| mail | `mail:send` ⚠, `mail:read`, `mail:admin` ⚠ |
| chat | `chat:create`, `chat:moderate` ⚠ |
| infra | `infra:read`, `infra:deploy` ⚠, `infra:dns` ⚠, `infra:admin` ⚠ |
| audit | `audit:read` |
| github | `github:read`, `github:write`, `github:sync`, `github:admin` ⚠ |
| drive | `drive:read`, `drive:write` |
| webhook | `webhook:read` |

Roles bundle permission keys. System roles: `admin`, `organizer`, `member` (plus custom
roles). A user's **effective** permissions are the union of their roles' keys — that list
is what `GET /api/v1/me` returns and what the FE gates on.

---

## 10. Authorization — the check API

### `POST /authz/check` (identity-roster, internal)

Batch decision endpoint behind `@dub/auth-client`. Component authors normally use the
client's `requirePermission(...)` middleware or `hasPermission(...)` rather than calling
this raw.

Request (`identity.AuthzCheckRequest`, `checks` length 1..20):

```json
{
  "subjectUserId": "user_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "orgId": "org_devhub",
  "checks": [
    { "permission": "task:write" },
    { "permission": "event:admin", "resourceType": "event", "resourceId": "evt_01J9Z..." }
  ]
}
```

`AuthzQuery`: `permission` (required), optional `resourceType` / `resourceId` for
resource-scoped checks (P0 supports event scope).

Response (`identity.AuthzCheckResponse`, decisions in request order):

```json
{
  "decisions": [
    { "allowed": true,  "evaluatedAt": "2026-08-10T05:00:00Z", "ttlSeconds": 60 },
    { "allowed": false, "evaluatedAt": "2026-08-10T05:00:00Z", "ttlSeconds": 60 }
  ]
}
```

- `ttlSeconds` — server-specified cache lifetime (default 60). The client LRU-caches
  non-dangerous decisions for this long; `dangerous` keys and `fresh` calls bypass cache.
- **Fail-closed:** any transport failure propagates as an error — a check never silently
  resolves to `allowed`.
- `checks` outside 1..20 -> `VALIDATION_FAILED` (`{ "field": "checks", "reason": "required" | "too_long" }`).

A denied permission at an endpoint surfaces to the client as `403 FORBIDDEN`.

---

## 11. Auth error codes (quick reference)

| Code | HTTP | Meaning / when |
|---|---|---|
| `UNAUTHENTICATED` | 401 | No session on a route that needs one (e.g. `/api/v1/me`) |
| `AUTH_INVALID_TOKEN` | 401 | Missing / malformed / unverifiable token |
| `AUTH_SESSION_EXPIRED` | 401 | Access token past expiry (refresh to recover) |
| `AUTH_SESSION_REVOKED` | 401 | Session revoked or past absolute lifetime (re-login) |
| `AUTH_STATE_MISMATCH` | (302 `?error=`) | OAuth `state`/PKCE mismatch or expired at callback |
| `AUTH_OAUTH_EXCHANGE_FAILED` | (302 `?error=`) | Google code exchange failed |
| `AUTH_USER_REJECTED` | (302 `?error=`) / 403 | Email not invited (invite-only provisioning) |
| `AUTH_INTERNAL_FORBIDDEN` | 403 | Internal-only route called without `x-dub-internal` |
| `FORBIDDEN` | 403 | Authenticated but lacks the required permission |

Client guidance:
- **401 on any call** -> attempt one silent `/auth/refresh`; if that also 401s, treat as
  logged out and route to login.
- **403** -> the user is logged in but not permitted; show a permission-denied surface, do
  not send them to login.
- Never branch on error `message` text (5xx is redacted); branch on `code` + HTTP status.
