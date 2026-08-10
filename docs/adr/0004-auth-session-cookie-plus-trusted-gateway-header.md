# ADR-0004: Authentication — session cookie at the edge, trusted gateway header internally

- Status: Accepted
- Date: 2026-08-10
- Deciders: DevHub (Dub) core
- Related: `@dub/auth-client`, `@dub/observability` (`x-dub-*` headers), identity-roster authz

## Context

Every downstream service (event, task, chat, mail, notification, …) needs to know **who**
is calling and **whether** they are allowed to perform an action. We do not want each of the
~16 services to independently parse and cryptographically verify a session token on every
request — that is duplicated work, duplicated risk, and extra latency. The stack is a
Cloudflare Worker mesh where an **API gateway** fronts internal services reached via
Service Bindings (`@dub/http` propagates `x-dub-*` headers).

Two concerns are separated:

- **Authentication (authn):** proving identity. Owned by `auth-service`; the browser holds
  a session.
- **Authorization (authz):** permission checks. Owned by `identity-roster` (`/authz/check`),
  wrapped by `@dub/auth-client` with a TTL cache.

## Decision

Adopt a **two-tier authn model**, implemented in `@dub/auth-client`
(`packages/auth-client/src/index.ts`) with `AuthMode = "trustedHeader" | "verify"`,
default **`trustedHeader`**.

1. **Edge / browser tier — session cookie.** The browser authenticates with a session
   cookie **`dub_session`** (or `Authorization: Bearer <token>`). The **API gateway** (the
   trust boundary) verifies the session against `auth-service` (`verify` mode:
   `POST /verify`, mapping `expired` → `AUTH_SESSION_EXPIRED`, `revoked` →
   `AUTH_SESSION_REVOKED`, else `AUTH_INVALID_TOKEN`).
2. **Internal tier — trusted header.** After the gateway verifies the session it injects the
   caller identity as **`x-dub-user-id`** (`DUB_HEADERS.userId`). Downstream services run
   `requireAuth()` in the default **`trustedHeader`** mode: they **trust `x-dub-user-id`**
   and do **not** re-verify the token. Absence of the header → `AUTH_INVALID_TOKEN` (401).
3. **Authorization is always a live check** (independent of authn tier). `requirePermission()`
   calls identity `/authz/check` via `@dub/auth-client`, which is **fail-closed** (any
   transport failure propagates as deny, never resolves to allow), caches decisions by
   `(userId, orgId, permission, resource)` with per-decision TTL, and **always bypasses the
   cache for "dangerous" permission keys** (fetched fresh every time).
4. **`x-dub-user-id` is only trustworthy behind the gateway.** The header must be stripped
   from any externally-originating request at the edge; internal services are reachable only
   via Service Bindings, so the header cannot be spoofed by an outside client.

## Consequences

- Positive: token verification happens **once, at the gateway**, not N times across services;
  downstream authn is a cheap header read. Lower latency and a single verification code path.
- Positive: authz stays correct and safe (fail-closed, dangerous-key freshness) regardless of
  how authn was resolved.
- Positive: `verify` mode still exists as a fallback for a service that must independently
  verify (e.g. a service exposed outside the gateway), so the model degrades gracefully.
- Negative / **critical invariant:** the whole scheme's safety rests on **the gateway (and
  only the gateway) setting `x-dub-user-id`**, and on the edge **stripping any inbound
  `x-dub-user-id`** from untrusted callers. If a service in `trustedHeader` mode were ever
  directly reachable from the internet without that stripping, identity could be spoofed.
  **(要確認)** confirm the gateway/edge config strips inbound `x-dub-*` identity headers.
- Negative: session revocation is only enforced at the gateway's `verify` step; downstream
  services trust the header for the life of the request. Acceptable because authz (the live,
  fail-closed `/authz/check`) is where real access decisions are made.
- `orgId` defaults to `common.DUB_DEFAULT_ORG_ID` when a route does not resolve a scope.

## Alternatives considered

| Option | Why not |
|---|---|
| Verify the session token in every service | Duplicates crypto/verify work and latency across ~16 services; `verify` mode kept only as a fallback. |
| Stateless JWT trusted everywhere (no gateway verify) | Revocation is hard; every service must hold verification keys. The gateway-verify + trusted-header split centralizes verification while keeping revocation at the edge. |
| Gateway also resolves permissions and passes them down | Couples authz to the gateway and staleness to request entry; live `/authz/check` with TTL cache + dangerous-key freshness is more correct. |
