# dt1_desktop — DevHub (Dub) desktop client

A native **Flutter desktop** client for the DevHub ecosystem. It talks to the
**same api-gateway as the web SPA** (online-first, no desktop BFF) through a
**generated-from-OpenAPI** Dart client, so it cannot drift from the web wire
contract by construction.

## What works (v1)

- **Auth** — interactive email + password login (`/api/v1/auth/password/login`);
  the session token is forwarded as `Authorization: Bearer` on every call. Sign
  out returns to the login screen.
- **Launcher shell** — a left rail mirroring the web `APP_MANIFEST`, with per-app
  RBAC grey-out (apps you lack permission for are non-selectable).
- **Data-backed apps**
  - **Home** — `/bff/home` (upcoming events + unread count), generated typed client.
  - **Profile** — `/me` (identity, org, effective permissions, session expiry).
  - **Notifications** — `/api/v1/notifications/inbox` (unread filter).
  - **My Tasks** — `/api/v1/tasks?assigneeId=<me>`.
  - **Events** — `/api/v1/events`.
  - **Gantt** — `/api/v1/gantt?eventId=` (event picker + progress bars).
- **Skeletons** (registered, "準備中" placeholder): chat, mail, usage, members,
  participation, driveshare, admin.
- **Theme** — generated from `@dub/tokens` (`tool/gen_theme.dart`), light + dark.

## Run it (review)

Prereqs: Flutter 3.29.x with macOS desktop enabled.

```
cd apps/dt1-desktop
flutter pub get
# point at prod (default) or a preview gateway:
flutter run -d macos --dart-define=DUB_API_BASE=https://api.developershub.jp
```

A pre-built release binary is produced by:

```
flutter build macos --release
# -> build/macos/Build/Products/Release/dt1_desktop.app  (double-click to open)
```

Log in with a `@developershub.jp` account (login is company-domain restricted
server-side).

## Test it

```
flutter test        # unit + proxy + full sign-in→every-app E2E journey
```

`test/e2e_screens_test.dart` boots the whole app against an in-memory seeded
backend, drives the real journey (login → each live app → sign out), and writes a
PNG of every screen to `screenshots/` (git-ignored).

## Regenerate (committed, "diff = red" in CI)

```
scripts/gen-dart-client.sh          # Dart gateway client from the OpenAPI SoT (repo root)
dart run tool/gen_theme.dart        # theme tables from @dub/tokens
dart run tool/gen_contract_json.dart # export wire + app registry for the Node parity tests
```

## Contract enforcement

- **Generated client** — `packages/api-client-dart`, from `docs/openapi/api-gateway.yaml`.
- **Desktop wire descriptor** — `lib/src/api/wire.dart`; proxy repos build queries
  from it, and `packages/e2e-smoke/test/desktop-wire.test.ts` reconciles it against
  the `<SVC>_WIRE` SoT (the wire-contract "4th face").
- **App parity** — `packages/e2e-smoke/test/desktop-parity.test.ts` reconciles the
  desktop app registry against `APP_MANIFEST`.

See `docs/desktop/_dart-client-generation.md` for the full rationale.
