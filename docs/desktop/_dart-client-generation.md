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

## Deferred (P0 tail — after contract-SoT stack lands)

1. **Wire-contract 4th face.** Fold the Dart client's query keys into the
   `<SVC>_WIRE` descriptor check (PR#234/#236) so a `?event=`-class regression
   turns the Dart face red too. Deferred to avoid colliding with the in-flight
   contract-SoT PRs that own `packages/types` + `@dub/e2e-smoke`.
2. **Per-service typed clients.** Extend generation beyond the gateway boundary
   to gantt/event specs as those `<SVC>_WIRE` descriptors stabilize.
3. **Design tokens → Flutter theme (P1).** Generate `AppTheme` values from
   `@dub/tokens` DTCG instead of the hand-set seed.
