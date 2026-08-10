# auth-service API Contract

Status: Component contract (v1). Owned by the **auth-service** component. Read
[`_conventions.md`](./_conventions.md) for the shared envelope, headers, codes and
[`auth.md`](./auth.md) for the cross-cutting auth/authz model. This doc is the concrete,
route-by-route wire spec of the **auth-service worker itself** — the service-local paths,
their request/response JSON, guards, and errors. Where `auth.md` describes the *external*
(gateway-prefixed) view, this doc describes what the service actually serves.

**Source of truth (code):**

| Concern | Code |
|---|---|
| Route table + guards | `services/auth-service/src/app.ts` |
| Session lifecycle (KV) | `services/auth-service/src/sessions.ts` |
| Service error codes | `services/auth-service/src/errors.ts` |
| Runtime config / bindings | `services/auth-service/src/env.ts` |
| identity provision client | `services/auth-service/src/identity-client.ts` |
| Wire types | `packages/types/src/auth.ts` |

---

## 1. Boundary & exposure

auth-service is an **internal** Cloudflare Worker. It is never called by browsers directly.
Callers reach it two ways:

| Route class | Reached by | How | Guard |
|---|---|---|---|
| Public web (`/auth/*`) | Browsers | via `api-gateway`, which proxies `/api/v1/auth/*` -> `/auth/*` (prefix stripped) | none (session carried in cookie/body) |
| OAuth callback (`GET /auth/callback`) | Google | direct to auth-service's own public hostname (Google redirects here) | none |
| Internal (`/verify`, `/mobile/exchange`, `/internal/revoke-user`) | gateway / MO3 / identity-roster | Cloudflare **Service Binding** | `x-dub-internal: 1` required |
| Dev (`/auth/test-login`) | local/preview tooling | via gateway | hard-gated OFF in production |

The service **binding name** callers use is not fixed here (pending the infra binding
registry); the routes below are the contract.

All bodies are `application/json`. Every non-2xx response is the uniform
`errors.ErrorResponse` envelope (`_conventions.md` §2.2) — **except** `GET /auth/callback`,
which never returns JSON and always `302`s (see §4).

The internal guard: any request to `/verify`, `/mobile/exchange`, or
`/internal/revoke-user` without the `x-dub-internal: 1` marker is rejected with
`AUTH_INTERNAL_FORBIDDEN` (403).

---

## 2. Route map

| Method & path (service-local) | Exposure | Auth / guard | Purpose |
|---|---|---|---|
| `GET /health` | internal | none | Liveness probe |
| `POST /auth/login` | web (via gateway) | none | Begin OAuth (PKCE); return Google `authorizationUrl` |
| `GET /auth/callback` | public (Google redirect) | none | OAuth redirect target; set cookie, 302 to SPA |
| `POST /auth/refresh` | web (via gateway) | cookie or bearer | Slide session; rotate token |
| `POST /auth/logout` | web (via gateway) | cookie or bearer | Revoke current session (idempotent) |
| `POST /auth/test-login` | web (via gateway) **local/preview only** | none | Mint a session for a userId without OAuth |
| `POST /verify` | internal (gateway / MO3) | `x-dub-internal` | Verify a token -> session |
| `POST /mobile/exchange` | internal (MO3 only) | `x-dub-internal` | Exchange mobile OAuth code for a bearer token |
| `POST /internal/revoke-user` | internal (identity-roster only) | `x-dub-internal` | Kill all sessions for a user |

Note: `GET /api/v1/me` is **gateway-owned**, not an auth-service route (see `auth.md` §5).

---

## 3. `GET /health`

Liveness. No auth.

Response `200`:

```json
{ "ok": true, "service": "auth-service" }
```

---

## 4. Web OAuth login

### `POST /auth/login`

Request (`auth.AuthLoginStartRequest`):

```json
{
  "redirectUri": "https://app.developershub.jp/home",
  "client": "web"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `redirectUri` | string | yes | Where to land in the SPA after callback. Must match the server redirect allowlist (`REDIRECT_ALLOWLIST`, default prefix `https://app.developershub.jp`). |
| `client` | `"web" \| "mobile"` | no | Transport class; defaults to `"web"`. |

Response `200`:

```json
{
  "authorizationUrl": "https://accounts.google.com/o/oauth2/v2/auth?client_id=...&code_challenge=...&state=8f3c2a1b9d",
  "state": "8f3c2a1b9d"
}
```

The browser navigates to `authorizationUrl`. The `state` and the PKCE code-verifier are
stored server-side in KV under `oauth_state:<state>` (single-use, TTL `STATE_TTL_SEC`,
default 600 s).

Errors:

| Situation | Body |
|---|---|
| Missing/empty `redirectUri` | `VALIDATION_FAILED` (400), `details: [{ "field": "redirectUri", "reason": "required" }]` |
| `redirectUri` not on allowlist | `VALIDATION_FAILED` (400), `details: [{ "field": "redirectUri", "reason": "not_allowed" }]` |
| Non-JSON body | `VALIDATION_FAILED` (400), `details: [{ "field": "body", "reason": "invalid_json" }]` |

### `GET /auth/callback?code=...&state=...`

Google redirects here after consent. **This endpoint always `302`s and never returns a JSON
error** — on failure it redirects to the SPA error URL with `?error=<CODE>`.

Flow: look up `oauth_state:<state>` in KV (single-use — deleted immediately), exchange the
`code` with Google using the stored PKCE verifier, resolve the identity user via invite-only
provisioning, create a **web** session, and set the cookie.

Success:

```
HTTP/1.1 302 Found
Set-Cookie: dub_session=<opaque-token>; HttpOnly; Secure; SameSite=Lax; Domain=.developershub.jp; Path=/; Max-Age=2592000
Location: https://app.developershub.jp/home
```

`Max-Age` is the session's absolute lifetime in seconds (web = 30 days). `Location` is the
`redirectUri` captured at login start (falls back to `SPA_SUCCESS_URL`).

Failure (redirects to `SPA_ERROR_URL` with the code appended as `?error=`):

```
HTTP/1.1 302 Found
Location: https://app.developershub.jp/login?error=AUTH_STATE_MISMATCH
```

Failure `error` codes:

| `error` value | Cause |
|---|---|
| `AUTH_STATE_MISMATCH` | `code`/`state` missing, or state not found in KV (expired / CSRF / replay) |
| `AUTH_OAUTH_EXCHANGE_FAILED` | Google code/token exchange failed |
| `AUTH_USER_REJECTED` | Email not invited — identity provisioning returned `rejected` |

Every callback outcome is written to the audit channel (`auth.session.login`,
`result: success | failure`).

---

## 5. Session shape

The only session object crossing the wire is `auth.SessionInfo`:

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
| `sessionExpiresAt` | number (**epoch-ms**) | Access-token expiry (`accessExpiresAt`). The one epoch-ms exception (`_conventions.md` §6.2). Refresh before this to slide the session. |

The token is **opaque** (a KV key, not a JWT) — clients must not parse it. Internally the
service keeps richer bookkeeping (`issuedAt`, `accessExpiresAt`, `absoluteExpiresAt`) in the
stored record; it never leaves the service.

Lifetimes (config-driven, `env.ts` defaults):

| Client | Access TTL | Absolute TTL |
|---|---|---|
| web | 3600 s (`SESSION_ACCESS_TTL_SEC`) | 30 days (`SESSION_ABS_WEB_TTL_SEC`) |
| mobile | 3600 s | 180 days (`SESSION_ABS_MOBILE_TTL_SEC`) |

Refresh rotates the token but preserves the original absolute deadline; the session cannot
outlive the absolute TTL.

---

## 6. `POST /auth/refresh`

Slides the access window and **rotates** the token (the old token dies immediately —
reusing it afterward resolves to `revoked`). Which path runs is chosen by how the token
arrives:

- **bearer path** (mobile): token from `Authorization: Bearer <token>`, or from
  `{ "refreshToken": "<token>" }` in the body. The new token is returned in JSON.
- **cookie path** (web): token from the `dub_session` cookie. A fresh cookie is set; no
  token in the body.

If either a bearer header or a `refreshToken` body field is present, the bearer path is
taken.

Request (`auth.AuthRefreshRequest`, body optional):

```json
{ "refreshToken": "dst_01J9Z8Q0X7M3K2P5R8T1V4W6Y9" }
```

Response — **bearer path** (`{ token, session }`):

```json
{
  "token": "dst_01J9Z8Q0X7M3K2P5R8T1V4W6YA",
  "session": { "userId": "user_01J9Z8Q0X7M3K2P5R8T1V4W6Y9", "client": "mobile", "sessionExpiresAt": 1760003600000 }
}
```

Response — **cookie path** (`{ session }` + `Set-Cookie`):

```json
{ "session": { "userId": "user_01J9Z8Q0X7M3K2P5R8T1V4W6Y9", "client": "web", "sessionExpiresAt": 1760003600000 } }
```

```
Set-Cookie: dub_session=<new-opaque-token>; HttpOnly; Secure; SameSite=Lax; Domain=.developershub.jp; Path=/; Max-Age=<remaining-abs-seconds>
```

Errors:

| Situation | Code | HTTP |
|---|---|---|
| Token missing / malformed / not KV-shaped | `AUTH_INVALID_TOKEN` | 401 |
| Token absent from KV / user force-revoked / past absolute lifetime | `AUTH_SESSION_REVOKED` | 401 |

Note: an **access-expired** token is *valid* input to refresh (that is the point) — it is
not an error here. Only malformed or revoked/absolute-expired tokens fail.

---

## 7. `POST /auth/logout`

Revokes the current session server-side. **Idempotent** — returns `200 { "ok": true }` even
if the token was already invalid or absent. Path selection mirrors refresh: bearer header or
`{ "token": "..." }` body chooses the bearer path; otherwise the cookie is read and cleared.

Request (optional body): `{ "token": "dst_01J9Z..." }`

Response `200`:

```json
{ "ok": true }
```

Cookie path additionally clears the cookie:

```
Set-Cookie: dub_session=; HttpOnly; Secure; SameSite=Lax; Domain=.developershub.jp; Path=/; Max-Age=0
```

---

## 8. `POST /auth/test-login` (local / preview only)

Mints a **web** session for a given `userId` without running OAuth — for local/preview
testing and seeding. Enabled only when `DUB_TEST_LOGIN=1` **and** the environment is not
`production`; otherwise every call fails `AUTH_TEST_LOGIN_DISABLED` (403).

Request (`auth.TestLoginRequest`):

```json
{ "userId": "user_01J9Z8Q0X7M3K2P5R8T1V4W6Y9" }
```

Response `200` (`{ token, session }`, plus a `Set-Cookie`):

```json
{
  "token": "dst_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "session": { "userId": "user_01J9Z8Q0X7M3K2P5R8T1V4W6Y9", "client": "web", "sessionExpiresAt": 1760003600000 }
}
```

Errors:

| Situation | Code | HTTP |
|---|---|---|
| Disabled (production, or `DUB_TEST_LOGIN != 1`) | `AUTH_TEST_LOGIN_DISABLED` | 403 |
| Missing/empty `userId` | `VALIDATION_FAILED` | 400 |

---

## 9. `POST /verify` (internal)

Called by the gateway / MO3 on each request to turn a token into a session. Requires
`x-dub-internal: 1`. **Never throws for auth outcomes** — it always returns the contract
shape; the *caller* maps `reason` to a `401` error code.

Request (`auth.AuthVerifyRequest`):

```json
{ "token": "dst_01J9Z8Q0X7M3K2P5R8T1V4W6Y9" }
```

Response `200` — valid (`auth.AuthVerifyResponse`):

```json
{
  "valid": true,
  "userId": "user_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "session": { "userId": "user_01J9Z8Q0X7M3K2P5R8T1V4W6Y9", "client": "web", "sessionExpiresAt": 1760000000000 },
  "reason": null
}
```

Response `200` — invalid:

```json
{ "valid": false, "userId": null, "session": null, "reason": "expired" }
```

`reason` (non-null only when `valid=false`) is one of:

| `reason` | Meaning | Entrypoint maps to |
|---|---|---|
| `"malformed"` | Empty / not KV-token-shaped | `AUTH_INVALID_TOKEN` (401) |
| `"expired"` | Access token past `accessExpiresAt` (refreshable) | `AUTH_SESSION_EXPIRED` (401) |
| `"revoked"` | Absent from KV / user force-revoked / past absolute lifetime | `AUTH_SESSION_REVOKED` (401) |

Guard failure (no `x-dub-internal`): `AUTH_INTERNAL_FORBIDDEN` (403).

---

## 10. `POST /mobile/exchange` (internal, MO3 only)

The native app runs the Google OAuth flow, then hands MO3 the authorization `code`; MO3
calls this internal route (requires `x-dub-internal: 1`). auth-service exchanges the code
with Google, provisions the identity user (invite-only), and creates a **mobile** session.

Request (`auth.MobileExchangeRequest`):

```json
{ "code": "4/0AXfooBarMobileAuthCode" }
```

Response `200` (`{ token, session }`):

```json
{
  "token": "dst_01J9Z8Q0X7M3K2P5R8T1V4W6Y9",
  "session": { "userId": "user_01J9Z8Q0X7M3K2P5R8T1V4W6Y9", "client": "mobile", "sessionExpiresAt": 1760003600000 }
}
```

The app stores `token` in the secure keychain and sends it as `Authorization: Bearer` on
subsequent BFF calls.

Errors:

| Situation | Code | HTTP |
|---|---|---|
| Missing `x-dub-internal` | `AUTH_INTERNAL_FORBIDDEN` | 403 |
| Missing/empty `code` | `VALIDATION_FAILED` | 400 |
| Google exchange failed | `AUTH_OAUTH_EXCHANGE_FAILED` | 502 |
| Email not invited (provision `rejected`) | `AUTH_USER_REJECTED` | 403 |

---

## 11. `POST /internal/revoke-user` (internal, identity-roster only)

identity-roster calls this to kill **all** of a user's sessions (e.g. on account
disable/delete). Requires `x-dub-internal: 1`. It writes a `revoked_user:<userId>` KV flag
(TTL = the longest absolute lifetime, 180 days); afterward every `/verify` for that user
returns `reason: "revoked"` until the flag expires.

Request:

```json
{ "userId": "user_01J9Z8Q0X7M3K2P5R8T1V4W6Y9", "reason": "account_disabled" }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `userId` | string | yes | Subject whose sessions are killed |
| `reason` | string | no | Free-text, recorded in the audit envelope |

Response `200`:

```json
{ "ok": true }
```

Errors:

| Situation | Code | HTTP |
|---|---|---|
| Missing `x-dub-internal` | `AUTH_INTERNAL_FORBIDDEN` | 403 |
| Missing/empty `userId` | `VALIDATION_FAILED` | 400 |

---

## 12. Error codes (service-specific)

Open half of the catalog, `<SERVICE>_<REASON>` (`services/auth-service/src/errors.ts`).
Common codes (`VALIDATION_FAILED`, `RATE_LIMITED`, `INTERNAL`, …) come from `@dub/errors`
per `_conventions.md` §3.

| Code | HTTP | When |
|---|---|---|
| `AUTH_INVALID_TOKEN` | 401 | Missing / malformed / non-KV-shaped token (refresh) |
| `AUTH_SESSION_EXPIRED` | 401 | Access token past expiry — mapped from `/verify` `reason: "expired"` at the entrypoint |
| `AUTH_SESSION_REVOKED` | 401 | Logged out / force-revoked / past absolute lifetime |
| `AUTH_STATE_MISMATCH` | 400 (surfaced as `302 ?error=` at callback) | OAuth `state`/PKCE missing, expired, or replayed |
| `AUTH_OAUTH_EXCHANGE_FAILED` | 502 (surfaced as `302 ?error=` at callback) | Google code/token exchange failed |
| `AUTH_USER_REJECTED` | 403 (surfaced as `302 ?error=` at callback) | Email not invited (invite-only provisioning) |
| `AUTH_INTERNAL_FORBIDDEN` | 403 | Internal-only route called without `x-dub-internal` |
| `AUTH_TEST_LOGIN_DISABLED` | 403 | `test-login` called while disabled (production / flag off) |

Client guidance is in `auth.md` §11 (401 -> one silent refresh then treat as logged out;
403 -> permission surface, do not route to login; never branch on `message` text).

---

## 13. Storage (KV keyspace)

auth-service is KV-only (no D1). One namespace (`AUTH_KV`) holds three key families:

| Key | Value | TTL |
|---|---|---|
| `session:<token>` | stored session record (`userId`, `client`, `issuedAt`, `accessExpiresAt`, `absoluteExpiresAt`) | absolute TTL (web 30d / mobile 180d) |
| `oauth_state:<state>` | `{ codeVerifier, redirectUri }` (single-use, deleted at callback) | `STATE_TTL_SEC` (default 600 s) |
| `revoked_user:<userId>` | `"1"` marker | 180 days (longest absolute) |

The token stored under `session:<token>` is the opaque credential; there is no separate
lookup table. Refresh writes a new `session:<newToken>` and deletes the old key atomically
enough that the old token immediately fails `/verify`.
