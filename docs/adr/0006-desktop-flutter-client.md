# ADR-0006: Desktop client — Flutter (macOS + Windows) over the shared gateway

- Status: Accepted (revised — see "Update 2026-09" below)
- Date: 2026-08-19
- Deciders: DevHub (Dub) core
- Related: ADR-0004 (auth session cookie), `apps/de1-desktop`, `docs/openapi/api-gateway.yaml`, `apps/mo1-ios` / `apps/mo2-android` (native mobile precedent)

## Update 2026-09: thin WebView shell, not a per-screen native rebuild

Between this ADR's proposal and shipping, several branches built out **native Flutter
widgets per screen** (chat, gantt, tasks, events) that re-implemented `apps/fe2-app-shell`
screen-by-screen. That duplicated the web app's UI/logic for no product benefit and was
abandoned (see the old `feat/de1-desktop-{chat,gantt,tasks,events-drive-settings,mail}`
branches — superseded, recommended for closing).

The decision that stands: **`apps/de1-desktop` is a Flutter app whose only screen is a
WebView (`flutter_inappwebview`) pointed at `fe2-app-shell`** (`lib/ui/web_shell.dart`).
Flutter is still the right framework choice (§1 below is unchanged — one codebase for
macOS/Windows, plus Android/iOS as of this update), but it is used as a **native app
shell/wrapper**, not as a UI-reimplementation layer. Everything in §3–6 below
(gateway-direct calls, cookie auth, contract reuse, state mgmt) applies to the *web app
inside the WebView*, not to Dart-side screens — de1-desktop itself has no feature code, no
models, and no state management beyond the shell (login-form autofill, app-lock,
WebView lifecycle, and OS push notifications).

Minimal native surface added on top of the WebView (kept intentionally small):
- **Face ID / Touch ID app-lock + credential autofill** (`lib/state/app_lock.dart`,
  `lib/state/autofill.dart`, `lib/state/credential_store.dart`) — biometric gate in front
  of the WebView, and JS-injected autofill of the login form from a securely stored
  credential, so returning users skip typing their password.
- **OS push notifications** (`lib/push/*`) — see the dedicated design note below.

## Update 2026-09 (push notifications) — 2-phase design

Desktop push does **not** rely on the web SPA's own push stack (no Service-Worker Web
Push from inside the WebView — `flutter_inappwebview`/WKWebView do not reliably support
that today). Instead:

- **Phase 0 — foreground, $0, zero server changes.** `lib/push/foreground_bridge.dart`
  injects a small JS watcher into the WebView page that reuses the SPA's own authenticated
  session to poll `GET /api/v1/notifications/inbox?unreadOnly=true` and bridges genuinely
  new items to `lib/push/push_notifications.dart` (`flutter_local_notifications`), which
  displays a uniform OS notification on every platform and routes a tap back into the SPA
  via `window.__dubNavigate`.
- **Phase 1+ — background/terminated remote wake.** `lib/push/fcm_push.dart` (Android, and
  macOS/iOS over FCM-on-APNs) and `lib/push/native_push.dart` + a native bridge
  (`ios/…/AppDelegate.swift`, `macos/…/AppDelegate.swift`,
  `windows/runner/push_channel.{h,cpp}`) obtain a platform push token and register it with
  `POST /m/v1/devices` on `mo3-mobile-bff` (already implemented server-side, including the
  APNs/WNS/FCM send adapters — this ADR only covers the client).

**Auth seam (resolved this update):** `POST/GET/DELETE /m/v1/devices` on `mo3-mobile-bff`
already accepts the WebView's own `dub_session` cookie as an alternative to a mobile
Bearer token (`apps/mo3-mobile-bff/src/app.ts` `cookieSession()`, added for exactly this
de1 track — de1 has no separate mobile login/token-exchange step). `lib/push/mo3_session.dart`
reads that cookie straight out of the WebView's cookie jar
(`CookieManager.instance().getCookie(url: AppConfig.apiBaseUrl, name: 'dub_session')`) and
sends it as a `Cookie:` header; a `--dart-define=MOBILE_BEARER=...` bearer still overrides
it for manual testing. Registration defers/retries only while genuinely logged out (no
cookie yet).

**Remaining open dependency (blocks Phase 1 going live in production):**
`mo3-mobile-bff`'s custom route (`m-api.developershub.jp`) is not deployed yet
(`workers_dev = false`, route commented out in `apps/mo3-mobile-bff/wrangler.toml`) — the
client is auth-ready but has nowhere to actually reach in prod until that route (or an
equivalent `AppConfig.mo3BaseUrl` override) ships.

## Context

The Dub ecosystem already ships a web app (`apps/fe*`) and two **native** mobile
clients — `apps/mo1-ios` (SwiftUI) and `apps/mo2-android` (Kotlin/Compose) — that reach
the backend through `apps/mo3-mobile-bff` (a Cloudflare Worker BFF for push, sync, and
aggregation). We now want a **desktop app for macOS and Windows** whose primary purpose is
everyday chat use and receiving OS notifications. The stated product goal is **feature
parity across web / desktop / mobile** ("機能差ゼロ"). The desktop app is described as
"almost equal to the web app" — the only expected difference is an optional local DB.

Key facts that constrain the decision:

- The **only external boundary is `api-gateway`** (`/api/v1`), documented as the single
  source of truth in `docs/openapi/*.yaml` and typed in `@dub/types`. Web clients talk to
  it directly; auth is a `dub_session` cookie (or `Authorization: Bearer`) verified at the
  gateway (ADR-0004).
- The monorepo is pnpm + turbo (TypeScript). The native mobile apps live under `apps/*`
  with a thin `package.json` + a TS "contract-consumption reference layer" that pins the
  wire contract they consume, plus the real native code in a subdirectory.

## Decision

1. **Framework: Flutter (Dart).** One codebase targets macOS and Windows (and later Linux
   / mobile if the "保留" mobile track is revived). Chosen over Electron (heavier runtime,
   JS re-implementation of the same screens) and over per-OS native (Swift + WinUI would
   double the work and diverge from the parity goal). Flutter 3.29 is already installed on
   the build machine.

2. **Placement: `apps/de1-desktop/`** — a new app dir following the `fe*` / `mo*` naming
   convention (`de` = desktop). It contains a standard Flutter project at the dir root
   (`lib/`, `macos/`, `windows/`, `test/`, `pubspec.yaml`). It has **no `package.json`**, so
   pnpm and turbo (which only pick up workspace members that have a `package.json`) simply
   ignore it — the existing web build/CI is untouched. A Dart CI job (`flutter analyze` +
   `flutter test`) is added separately.

3. **Talk to the shared gateway directly, web-style (not through mo3-bff).** Desktop is
   "web-like", so it uses the same `/api/v1` composition + proxy routes the web app uses,
   not the mobile BFF. The mobile BFF's offline-snapshot / mutation-queue machinery is a
   mobile concern; desktop can adopt pieces later if an offline mode is wanted.

4. **Auth = web-parity cookie session.** Login posts to
   `POST /api/v1/auth/password/login` (company email + password, the only interactive
   login). The `Set-Cookie: dub_session` response is captured by a persistent cookie jar
   and replayed on every subsequent gateway call — identical to a browser. This avoids any
   assumption about token/cookie equivalence and reuses the exact ADR-0004 flow. Bearer
   tokens remain available as an alternative if a headless/token path is ever needed.

5. **Contract is reused, never re-authored.** Dart request/response models mirror
   `@dub/types` / the OpenAPI specs. For the scaffold they are hand-written for the few
   endpoints the vertical slice touches; the durable plan is to **generate the Dart models
   from `docs/openapi/*.yaml`** so there is one source of truth (see architecture doc). A TS
   contract-parity layer (mirroring `apps/mo1-ios/src`) can be added to fail CI if the Dart
   models drift from the wire contract.

6. **State management: Riverpod. HTTP: dio + cookie_jar.** All pure-Dart, no platform
   channels — so the macOS/Windows builds need no extra CocoaPods/native plugins, keeping
   the build fast and low-friction. Local DB (drift/sqlite) is deferred until an offline or
   cache requirement is concrete.

## Consequences

- Positive: one desktop codebase for both OSes; the same gateway contract as web means
  feature parity is a matter of building screens, not re-negotiating APIs.
- Positive: zero impact on the existing web/service build — the Flutter dir is invisible to
  pnpm/turbo; additive only.
- Positive: browser-identical auth means sessions, expiry, and revocation behave exactly as
  on web.
- Negative / follow-up: **native OS push notifications** (the core motivation) are not yet
  designed here. Desktop push likely reuses `notification` + a desktop-appropriate channel
  (local notifications now; APNs/FCM-style transport later, possibly via mo3-bff's device
  registry). Tracked as the next design step, not this ADR.
- Negative: hand-written Dart models are a temporary duplication until OpenAPI→Dart codegen
  is wired; until then, drift is possible (mitigated by the planned parity test).
- Follow-up: cross-platform persistent storage currently uses the OS home dir; production
  should use `path_provider`'s application-support directory.

## Alternatives considered

| Option | Why not |
|---|---|
| Electron + reuse the React web app | Ships a full Chromium per install; still a separate build & packaging story; Flutter gives true-native windows and one language for future mobile parity. |
| Native Swift (macOS) + WinUI (Windows) | Doubles UI work across two toolchains and diverges from the "機能差ゼロ" parity goal; mobile already pays the native cost. |
| Route desktop through `mo3-mobile-bff` | The BFF exists for mobile-shaped concerns (push, offline snapshot, mutation queue). Desktop is web-shaped; going direct to the gateway keeps it identical to web and avoids an extra hop/service to evolve. |
| Put the app under an existing `mo*` dir | Those are native iOS/Android projects; desktop is a distinct target and deserves its own app dir. |
