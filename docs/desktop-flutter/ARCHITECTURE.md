# DAV Desktop (Flutter) — architecture memo

Minimal design note for the desktop client (`apps/de1-desktop`). The formal
decision is ADR-0006. This is the "how it's built + where it's going" companion.

## Goal

A **macOS + Windows** desktop app that is **feature-equal to the web app**
("機能差ゼロ"). Primary motivation: everyday chat + OS notifications. Desktop is
"web-like" — same shared gateway contract, the only intended structural
difference is an optional local DB (deferred).

## Non-negotiables

- **One contract, reused.** All traffic goes through `api-gateway` (`/api/v1`),
  the single source of truth documented in `docs/openapi/*.yaml` and typed in
  `@dub/types`. The desktop app never invents its own endpoints or duplicates the
  contract by hand long-term (see "Contract reuse" below).
- **Additive to the monorepo.** `apps/de1-desktop` has no `package.json`, so pnpm
  and turbo ignore it — the web/service build and CI are untouched. A separate
  Dart CI job runs `flutter analyze` + `flutter test`.
- **No paid dependencies, local-first.** All Dart deps are pure-Dart (no native
  plugins), so macOS/Windows builds need no extra CocoaPods.

## Layers (as built for the vertical slice)

```
lib/
  config.dart            GATEWAY_BASE_URL + dev auto-login defines
  api/
    models.dart          Dart mirrors of the wire contract (MeResponse, InboxItem, ...)
    gateway_client.dart  dio + persistent cookie jar over /api/v1
  state/
    auth.dart            Riverpod: gatewayClientProvider + AuthController (phases)
    notifications.dart   Riverpod: inboxProvider (FutureProvider)
  ui/
    theme.dart           Material3 seed (approximates @dub/tokens)
    login_screen.dart    email + password
    app_shell.dart       top bar + 9-dot app launcher (web-parity nav)
    inbox_view.dart      the vertical-slice feature (notification inbox)
tool/mock_gateway.dart   contract-faithful local stand-in for the gateway
integration_test/        live-HTTP end-to-end slice + screenshot capture
```

- **State management: Riverpod.** `gatewayClientProvider` (async singleton),
  `authControllerProvider` (StateNotifier with `unknown/unauthenticated/
  authenticating/authenticated`), `inboxProvider` (FutureProvider).
- **HTTP: dio + cookie_jar.** `PersistCookieJar` captures `Set-Cookie:
  dub_session` on login and replays it on every call — browser-identical auth
  (ADR-0004). Non-2xx bodies are decoded into `DubApiException` from the
  `@dub/errors` envelope. Bearer tokens remain a fallback if ever needed.
- **Auth flow:** on launch, probe `/api/v1/me` (persisted cookie → straight to
  the shell; 401 → login). Login → `POST /api/v1/auth/password/login` → `/me` →
  shell. Logout revokes + clears the jar.
- **Shell:** a Chrome-style **9-dot app launcher** (matches the web launcher —
  memory: dub-shell-app-launcher-nav) listing Notifications, Chat, Tasks, Gantt,
  Mail, Events, Roster, Drive. Only the implemented app is enabled; the rest are
  greyed with a lock (matches the web release-gating pattern).

## Contract reuse (the "機能差ゼロ" mechanism)

The models in `api/models.dart` are hand-written **only for the slice**. The
durable plan, in priority order:

1. **Generate Dart models from `docs/openapi/*.yaml`** (e.g.
   `openapi-generator` `dart-dio` or `swagger_parser`) into `lib/api/generated/`,
   so front/back share exactly one contract. Wire it as a codegen step, not
   committed-by-hand types.
2. **Add a contract-parity guard** mirroring `apps/mo1-ios/src` — a small TS
   layer that imports `@dub/types` and asserts the Dart JSON shapes match, failing
   CI on drift. This is how the native mobile apps lock their contract today.

Until (1) lands, keep hand-written models minimal and reviewed against the specs.

## Platform / build

- **macOS:** App Sandbox is on; the client needs
  `com.apple.security.network.client` in **both** `DebugProfile.entitlements` and
  `Release.entitlements` (added — the default template omits it, which silently
  blocks all outbound HTTP). Build: `flutter build macos`.
- **Windows:** `flutter build windows` (no sandbox entitlement needed). Not
  verified on hardware here; CI should add a `windows-latest` build job. No
  native plugins → no per-OS plugin setup.
- **CI:** add a Flutter job (`flutter analyze`, `flutter test`, `flutter build
  macos --debug`, `flutter build windows`). Keep it separate from the pnpm/turbo
  pipeline.

## Vertical slice (done)

Login → shell → **notification inbox**, over **real HTTP**. Proven by the
integration test driving the real macOS app against `tool/mock_gateway.dart`
(a contract-faithful stand-in used because the production gateway is not
reachable and running the full Workers stack is out of scope for the scaffold).
The mock log shows the real request sequence: `GET /me` (401) → `POST
/auth/password/login` (Set-Cookie) → `GET /me` (authed) → `GET
/notifications/inbox`. Screenshot: `~/DubVault/docs/dav-desktop-flutter/`.

## Next steps (for feature parity)

1. **Chat** (the main everyday-use driver): `GET /api/v1/chat/channels` +
   messages; realtime is Durable-Object-direct (WebSocket) per ADR-0002 — the
   gateway rejects WS upgrades, so chat realtime connects to the DO with a
   `ws-ticket` from `/chat/channels/{id}/ws-ticket`.
2. **Native push notifications** (the other motivation): local notifications
   first; a device-registration + APNs/FCM-style transport later (possibly
   reusing `mo3-mobile-bff`'s device registry). Needs a design step — not yet
   decided.
3. **OpenAPI→Dart codegen + parity test** (see "Contract reuse").
4. **Real login UX** (domain hint, error states) and **window/state management**
   (window_manager, tray icon, deep-link routing).
5. **@dub/tokens** wiring so the desktop theme is the same source of truth as web.
```
