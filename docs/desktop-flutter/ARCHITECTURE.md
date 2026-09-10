# Dub Desktop (Flutter) — architecture memo

Design note for the desktop client (`apps/de1-desktop`). The formal decisions are
ADR-0006 (framework = Flutter) and **ADR-0007 (the app is a WebView 完コピ of the web app,
grown native incrementally)**. This is the "how it's built + where it's going" companion.

## Goal

A **macOS + Windows** desktop app that is a **perfect copy (完コピ)** of the web app —
identical down to button positions — because it renders the real Web SPA, not a
re-implementation. It must stay in lockstep with the web app automatically, and it must
leave room to replace individual screens with native Flutter widgets later.

## The shape (today)

```
lib/
  config.dart            WEB_BASE_URL (the Web SPA origin to render)
  feature_registry.dart  the single seam for progressive native-ization
  main.dart              MaterialApp('Dub') -> one full-window InAppWebView
macos/  windows/         native shells (window titled "Dub")
```

- **The whole window is one WebView** (`flutter_inappwebview`) pointed at
  `AppConfig.webBaseUrl`. macOS renders it with WKWebView, Windows with WebView2 — the OS's
  own browser engine, so there is no bundled Chromium and no second render path.
- **No bespoke Flutter UI (yet).** Login, the 9-dot launcher, and every feature screen are
  the exact web bundle the browser serves. Button positions, states, everything match
  because it *is* the web app. Web deploys need no desktop release.
- **Auth is browser-identical.** The `dub_session` cookie lives in the WebView's cookie
  store exactly as in a browser; login is the web login form. The shell handles no
  credentials (ADR-0004 preserved for free).

## Connection

- Default `WEB_BASE_URL` = `https://dub-fe2-app-shell.developershub-site.workers.dev`
  (the production fe2 worker — a real, reachable origin).
- Override for demo or local dev:
  `flutter run -d macos --dart-define=WEB_BASE_URL=https://<origin-or-localhost:5173>`.
- `api.developershub.jp` is **not** DNS-configured and is never a default.

## 漸進的ネイティブ化 (progressive native-ization) — the whole point of keeping Flutter

The desktop app starts as pure WebView 完コピ, but is built so screens can move off the web
onto native Flutter widgets **one feature at a time**, with the web page always the default
and fallback. The entire switch lives in one file: `lib/feature_registry.dart`.

```
enum DubFeature { notifications, chat, tasks, gantt, mail, events, roster, drive, settings }
FeatureRegistry.registerNative(DubFeature.tasks, (ctx) => TasksView());  // port one screen
FeatureRegistry.hasNative(feature)   // is this feature native yet?
FeatureRegistry.entryUrl()           // where the WebView opens (web app root, today)
```

Porting procedure, per screen:

1. Implement the screen as a Flutter widget (using the shared gateway contract).
2. Register it: `FeatureRegistry.registerNative(DubFeature.<x>, (ctx) => <Widget>());`.
3. The shell renders that widget instead of the WebView for that feature (by intercepting
   web navigation to `feature.webPath` and swapping in the native builder). Every
   feature **not** registered keeps rendering the web page untouched.

Because unported features always fall back to the web page, parity can never regress for
screens that have not been converted. Nothing outside `feature_registry.dart` needs to know
which features are native — that map is the whole seam.

Recommended porting order matches the web usage / ADR-0006 follow-ups: chat first (the main
everyday driver, incl. Durable-Object realtime), then notifications (native OS push), then
the rest.

## Platform / build

- **macOS:** App Sandbox on; `com.apple.security.network.client` is set in **both**
  `DebugProfile.entitlements` and `Release.entitlements` (needed for the WebView's outbound
  HTTPS). Min deployment target is **10.15** (raised from the Flutter template's 10.14) —
  `flutter_inappwebview`'s WebAuthenticationSession conforms unconditionally to a protocol
  whose method is `@available(macOS 10.15)`, which a 10.14 target rejects under the current
  Xcode. Set in `macos/Podfile` (`platform :osx, '10.15'` + a `post_install` override) and
  in `macos/Runner.xcodeproj` (`MACOSX_DEPLOYMENT_TARGET = 10.15`). Build: `flutter build
  macos`. Run: `flutter run -d macos`.
- **Windows:** `flutter build windows` (WebView2 runtime is present on modern Windows). Not
  verified on hardware here; CI should add a `windows-latest` build job. Window titled "Dub"
  in `windows/runner/main.cpp`.
- **CI:** a Flutter job (`flutter analyze`, `flutter test`, `flutter build macos --debug`,
  `flutter build windows`), separate from the pnpm/turbo pipeline. `apps/de1-desktop` has no
  `package.json`, so pnpm/turbo ignore it and the web build/CI are untouched.

## Verified

`flutter analyze` clean, `flutter test` green, `flutter build macos --debug` succeeds, and
the app launches showing the real web login page — pixel-identical to the browser (title bar
reads "Dub"). Comparison screenshots: `~/DubVault/docs/dub-desktop-webclone/`.
