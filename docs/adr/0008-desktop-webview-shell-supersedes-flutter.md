# ADR-0008: Desktop client — WebView shell over `apps/fe2-app-shell` (supersedes ADR-0006)

- Status: Accepted
- Date: 2026-09-28
- Deciders: DevHub (Dub) core
- Related: supersedes ADR-0006 (desktop-flutter-client); ADR-0004 (auth session
  cookie); `apps/fe2-app-shell`; `services/notification`

## Context

ADR-0006 chose a full Flutter (Dart) native app at `apps/de1-desktop` for macOS
+ Windows desktop. That app duplicated a second UI codebase (Dart models,
Riverpod state, hand-mirrored API contracts) to render screens that already
exist and are maintained in the web app (`apps/fe2-app-shell` and the `fe*`
apps it composes). That duplication is the wrong trade for a single-developer
project: every web feature now needs a second implementation to stay at
"機能差ゼロ", which does not scale and already drifted (contract mirrors,
hand-written Dart models, separate CI job).

The corrected decision: **desktop is the existing web app shown in a WebView**,
not a reimplementation. `apps/de1-desktop` (Flutter/Dart, all platforms) has
been deleted from the repo in this change. There is currently **no WebView
desktop shell in the repo yet** — this ADR records the target shape so the
next implementation step (a thin shell app) has a place to land, and a
minimal build order for OS push notifications, which was the one gap Flutter
was trying to solve.

## Decision

1. **Shell technology: a thin native WebView wrapper (Tauri preferred; WKWebView
   directly on macOS, or Electron only if Tauri proves infeasible), not a
   second application framework.** The shell's only job is: open a window,
   point a WebView at the deployed `fe2-app-shell` URL (or load it from a local
   bundle for offline chrome), and bridge the small set of things a browser
   tab cannot do — OS-level push registration/delivery, and (later) a system
   tray icon. Screens, state, auth, and API calls stay 100% in the existing
   web app. No Dart, no second UI codebase.

2. **Placement: a new, small `apps/de1-desktop` (or a fresh app id if that
   name should be avoided to prevent confusion with the deleted Flutter app)
   containing only shell code** (Tauri/WKWebView project + the minimal native
   bridge below). It should be small enough that "feature parity" is
   automatic — there is only one UI to build.

3. **Auth stays browser-identical.** The WebView is just a browser surface; it
   uses the same `dub_session` cookie flow as web (ADR-0004). No token
   duplication, no separate login screen.

4. **Push notifications: web-first, native bridge only where the OS requires it.**
   - Primary path: Firebase Cloud Messaging **Web SDK** (`firebase/messaging`,
     `getToken()`) running inside the WebView's page context, same as a
     browser tab would do, backed by a service worker for background delivery
     where the WebView engine supports it (Chromium-based shells / Tauri on
     Windows & Linux support SW push out of the box).
   - Native bridge (minimal, additive-only): only where the WebView engine
     cannot deliver background push itself — chiefly **macOS WKWebView**,
     which has no background Service Worker push. There, the shell registers
     for **APNs** natively (a few dozen lines of Swift/Tauri-plugin code),
     forwards the resulting device token to the page via `postMessage`/a JS
     bridge, and the page hands it to `services/notification` exactly like a
     web push subscription — no second notification pipeline, no separate
     device-token table schema.
   - **This backend half is already built and merged to `main`, independent of
     the Flutter app removed here.** `apps/mo3-mobile-bff` already exposes
     `POST/GET/DELETE /m/v1/devices` behind `requireAuthCookieOrBearer` — its
     own comment says "de1 WebView (dub_session cookie) ... register/list/
     unregister their push token here" — and its `mobile_devices.platform`
     CHECK already includes `'macos'` / `'windows'` (migration
     `0003_devices_platform_4values`), with working `apns.ts` / `fcm.ts` /
     `wns.ts` send adapters wired into `dispatchPush`. Nothing needs to be
     added server-side; the only missing piece is the client that calls
     `POST /m/v1/devices` with a real token.

5. **No offline/local DB.** Same as ADR-0006's original scope — deferred,
   unnecessary for a WebView shell (the web app already handles its own
   caching/optimistic UI).

## Consequences

- Positive: one UI codebase again (the web app). Desktop "feature parity" is
  structural, not a maintenance promise.
- Positive: the only new code is a small shell + one push adapter — far less
  surface than a parallel Flutter app.
- Positive: `apps/de1-desktop`'s deletion is zero-impact on pnpm/turbo/CI,
  same as its addition was (it had no `package.json`).
- Negative / follow-up: the WebView shell itself does not exist yet in the
  repo as of this ADR — it needs to be scaffolded (Tauri recommended for a
  single cross-platform (macOS + Windows) codebase with a small binary size).
- Negative / follow-up: macOS WKWebView push needs an Apple Push Notification
  service (APNs) certificate/key and a small native bridge; this is the one
  piece of genuinely native code the desktop track needs, and it is scoped to
  "send the OS a token", nothing more.
- Follow-up: the abandoned Flutter feature branches (`feat/de1-*`,
  `fix/de1-desktop-*`, `build/de1-desktop-dist`) should be closed without
  merging once this PR lands, rather than rebased forward.

## Alternatives considered

| Option | Why not |
|---|---|
| Keep Flutter, just add push (ADR-0006 status quo) | Keeps the duplicated UI codebase this ADR exists to remove; doesn't address the root complaint. |
| Electron wrapping the web app | Works, but ships a full Chromium per install and is heavier than Tauri for the same "just show the web app" job; kept as a fallback if Tauri's WebView engine (WKWebView/WebView2) has a showstopper. |
| Re-implement push server-side only (no shell) | Doesn't solve OS-level notification delivery on desktop when the app isn't a foreground browser tab; still needs *some* native surface (APNs on macOS) to receive push while the window is closed. |
