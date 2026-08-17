# Dart client generation (Flutter desktop)

> Status: **P0** — pipeline + vertical smoke landed. The wire-contract "4th face"
> (Dart keys folded into the `<SVC>_WIRE` 3-way check from PR#234/#236) is a
> **deferred P0-tail task**, to be added once the contract-SoT stack lands on
> `epic/dub-features`. See "Deferred" below.

## Why generate (never hand-write)

The Flutter desktop app talks to the **same api-gateway as the web SPA** (online-
first, no desktop BFF — roadmap §5). Its API client is **generated from the
OpenAPI SoT**, not hand-written. Reason: drift only enters when a client
re-transcribes the wire shape by hand (the gantt `?event=` vs `?eventId=` bug,
PR#231). Generating makes "client key == OpenAPI field name" true by
construction, so there is nowhere to write an alias.

## Source of truth

- **Input:** `docs/openapi/api-gateway.yaml` (the single external boundary).
- **Output:** `packages/api-client-dart` — a standalone Dart package
  (`dub_api_client`). It is **committed**, including the `built_value`
  `*.g.dart` serializers.
- **Generator:** `openapi-generator` **7.24.0** (dart-dio), pinned in the script.

`docs/openapi/*.yaml` and `@dub/types` are kept in agreement by the existing
`@dub/e2e-smoke` conformance tests (unchanged here). This Dart pipeline consumes
the OpenAPI spec **read-only** — it never edits contract files.

## Commands

```
# regenerate the client (models + APIs + built_value serializers)
scripts/gen-dart-client.sh

# CI mode: regenerate, then fail if the committed client is stale
scripts/gen-dart-client.sh --check
```

Under the hood:

```
openapi-generator generate \
  -i docs/openapi/api-gateway.yaml \
  -g dart-dio \
  -o packages/api-client-dart \
  --additional-properties=pubName=dub_api_client,pubLibrary=dub_api_client.api,pubAuthor=DevelopersHub,nullableFields=false
# then, inside the package:
dart run build_runner build
```

Requirements ($0, no paid deps): `openapi-generator` (`brew install
openapi-generator`, needs a JDK) and `dart`/`flutter` for `build_runner`.

## Freshness guarantee ("regenerate → diff = red")

The generated client is committed. `scripts/gen-dart-client.sh --check`
regenerates and fails on any `git diff` under `packages/api-client-dart`. Wire
this into CI so a contract change that isn't re-generated cannot merge. A
starter workflow lives at `.github/workflows/flutter-ci.yml` (analyze + test +
the freshness check).

## Consuming it (desktop app)

`apps/dt1-desktop` depends on the package by path and builds one
`DubApiClient` in `lib/src/api/gateway_client.dart`. Feature code uses thin
repositories (e.g. `MeRepository`) over `getGatewayApi()`, never the generated
surface directly — so regeneration never ripples into widgets.

## P0 vertical smoke (proven)

`apps/dt1-desktop/test/me_smoke_test.dart` stands up an in-process mock gateway,
serves the OpenAPI `MeResponse` JSON at `/api/v1/me`, and asserts the **generated
built_value model** decodes it via `MeRepository`. `flutter build macos`
compiles the desktop binary. Together: web-spec → Dart client → desktop UI is
wired end to end.

## P1–P3 (landed on top of P0)

1. **Auth wiring (P1).** `lib/src/auth/*` — an interactive email+password login
   (`POST /api/v1/auth/password/login`) captures the session token and forwards
   it as `Authorization: Bearer` on every gateway call (the frozen extraction
   order is Bearer→cookie). `AuthController` gates the app between the login
   screen and the shell; `/me` composes identity + effective permissions.
2. **Design tokens → Flutter theme (P1).** `tool/gen_theme.dart` reads
   `packages/tokens/tokens.json` (DTCG) and emits `lib/src/theme/tokens.g.dart`;
   `AppTheme` builds light+dark from it. Committed, `--check` in CI.
3. **Real apps (P1/P2).** A launcher shell (mirrors `APP_MANIFEST`, per-app RBAC
   grey-out) with data-backed screens: Home (`/bff/home`), Profile (`/me`) — both
   the generated typed client — plus Notifications, My Tasks, Events and Gantt via
   the gateway's transparent proxy. Proxy query keys come from the desktop wire
   descriptor (`lib/src/api/wire.dart`), never hand-written literals.
4. **Wire-contract 4th face (P3).** `packages/e2e-smoke/test/desktop-wire.test.ts`
   reconciles the exported desktop wire keys (`apps/dt1-desktop/contract/
   desktop_wire.g.json`) against the `<SVC>_WIRE` SoT (gantt/notification/event).
   A `?event=`-class regression on the Dart side turns this red.
5. **App-parity CI (P3).** `packages/e2e-smoke/test/desktop-parity.test.ts`
   reconciles the desktop app registry against `APP_MANIFEST`, so a web app added
   without a desktop entry (at least a `skeleton`) fails CI.

## Still deferred

- **Per-service typed clients.** Extend generation beyond the gateway boundary to
  gantt/event/notification/task specs (generated models instead of the current
  hand-written proxy models). The proxy repositories are the seam this slots into.
- **Response-shape conformance.** The 4th face guards query keys; add the fe6 zod
  pattern for request/response *shapes* on the Dart side too.
- **Skeleton→live.** chat / mail / usage / members / participation / driveshare /
  admin are registered skeletons; bring each to a data-backed screen.
