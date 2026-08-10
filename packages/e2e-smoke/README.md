# @dub/e2e-smoke

Cross-service **integration smoke** + **OpenAPI↔route contract-conformance** for the
DevHub (Dub) ecosystem. Self-contained: owns only `packages/e2e-smoke`, changes no
existing service. Runs on plain **node + vitest** (no miniflare / wrangler / browser).

## Run

```
pnpm --filter @dub/e2e-smoke test        # this package
pnpm --filter @dub/e2e-smoke typecheck
```

## 1. Integration smoke (`test/smoke.test.ts`)

Drives the primary use case end to end over **one seeded local D1**:

```
user → event create → task → assignment → notification inbox → mail send outbox
```

- The D1 is a real **`node:sqlite`** database (`src/d1.ts`) seeded with the actual
  schema DDL of four namespaces (`event_*`, `task_*`, `notif_*`, `mail_*`) — the same
  in-memory-D1 technique the per-service suites already use.
- Each leg runs the **service's own code**:
  - event-service: REAL Hono app via `app.request`, REAL `createD1EventRepo`.
  - task-service: REAL Hono app via `app.request`, REAL `createD1TaskRepo`; the
    assignment raises the canonical `task.assigned` `@dub/events` envelope, captured
    through the publisher seam. The event-existence gate reads the real event row.
  - notification: REAL `notif_` repo SQL (`insertNotification` + `insertInbox`),
    read back via `listInbox` / `unreadCount`.
  - mail-gateway: REAL `sendMail` send-core against the real `mail_send_log` outbox,
    including its idempotent replay guarantee.
- Only **transport seams** are faked (authz allow, service bindings, Queues, mail
  provider = `MockMailProvider`). All domain rules and every table write are real, so
  guardrails still bite (missing-event reject, stale-version 409, unauth 401).

## 2. Contract conformance (`test/conformance.test.ts`)

Reconciles each service's implemented Hono routes (parsed from `src/app.ts`, incl.
sub-router mounts) against its OpenAPI 3.1 spec `paths`. Specs come from the repo's
canonical `docs/openapi/` when present, otherwise the vendored **snapshot of PR #59**
in `fixtures/openapi/` (so the check is meaningful before #59 merges).

The per-service drift map is asserted against the golden `conformance-baseline.json`;
any future divergence between code and contract turns the suite red. Current findings
(16 services, 13 exact matches):

| service | finding |
|---|---|
| api-gateway | code mounts under `/api/v1` while the spec is written post-prefix-strip; spec also declares the generic proxy path `/{service}/{rest}` not present as a literal route |
| deploy-service | 7 documented endpoints are not yet implemented (only `/internal/health` exists) — a skeleton service |

Regenerate the baseline by deleting `conformance-baseline.json` and re-running (it
bootstraps on absence).
