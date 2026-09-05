# ADR-0007: Desktop client is a WebView clone of the web app (progressive native-ization)

- Status: Accepted
- Date: 2026-08-19
- Deciders: DevHub (Dub) core
- Supersedes: the screen-building parts of ADR-0006 (Flutter framework + single-gateway
  framing are kept; the "re-implement each screen in Flutter with dio + Riverpod" plan is
  replaced by this ADR).
- Related: `apps/de1-desktop`, `apps/fe2-app-shell` (the Web SPA being rendered), ADR-0004
  (auth session cookie).

## Context

ADR-0006 chose Flutter for the desktop app and set out to **re-implement each web screen**
in Dart (dio + Riverpod + hand-mirrored contract models). In practice that produced a
desktop app whose screens drifted from the web app — layouts, button positions and states
did not match, and several screens were broken. The product owner's requirement is blunt:

> 構成を全部Webアプリと全く同じにする＝ボタンの位置から何まで完璧にWebと一致。
> 独自UIを作らない・作り直さない。「ただ完コピするだけでいい」。

i.e. the desktop app must be a **perfect copy (完コピ)** of the web app — identical down to
button positions — not a re-implementation. A re-implemented UI can never guarantee that and
has to chase every web change forever.

## Decision

1. **The desktop window renders the real Web SPA (`fe2-app-shell`) verbatim.** The whole
   window is a full-bleed WebView pointed at the production fe2 origin. There is (for now)
   **no bespoke Flutter UI**: login, the 9-dot launcher, and every feature screen are served
   by the exact same web bundle the browser loads. This makes the desktop UI a literal copy
   of the web UI and makes it **auto-follow every web deploy** for free.

2. **Keep Flutter as the native shell; embed the WebView via `flutter_inappwebview`.**
   macOS uses WKWebView, Windows uses WebView2 — both are the OS's own browser engine, so
   there is no bundled Chromium and no second rendering path to keep in sync. Flutter is
   retained (over a pivot to Tauri/Electron) because the existing `apps/de1-desktop`
   macOS/Windows scaffold already builds and because Flutter is where the **incremental
   native-ization** below happens.

3. **Auth is browser-identical, for free.** The session cookie (`dub_session`) lives in the
   WebView's cookie store exactly as in a browser; login is the web login form. Nothing in
   the shell handles credentials. This preserves the ADR-0004 flow with zero desktop-specific
   auth code.

4. **Connect to the real, reachable origin.** Default = the production fe2 worker
   `https://dub-fe2-app-shell.developershub-site.workers.dev`, overridable with
   `--dart-define=WEB_BASE_URL=…` (e.g. the demo env or a local `vite dev`). The custom
   domain `api.developershub.jp` is **not** DNS-configured and is never a default.

5. **Design for progressive native-ization ("漸進的ネイティブ化").** The point of keeping
   Flutter is that individual screens can later be moved off the web and onto native Flutter
   widgets, **one feature at a time**, without disturbing the rest. All routing goes through
   a single seam — `lib/feature_registry.dart` (`FeatureRegistry`) — which today maps every
   feature to the WebView and holds no native builders. To port a screen: implement it as a
   widget, `FeatureRegistry.registerNative(feature, builder)`, and the shell renders that
   widget for that feature while every unregistered feature keeps rendering the web page.
   The default and fallback is always the web page, so parity can never regress for
   screens that have not been ported.

## Consequences

- Positive: **exact parity, by construction.** The desktop app cannot drift from the web app
  because it *is* the web app; button positions et al. match automatically and web deploys
  need no desktop release.
- Positive: near-zero desktop code — a WebView, a title, and a registry seam — so the surface
  to maintain and break is tiny.
- Positive: a clean, documented path to add native screens later without a rewrite.
- Neutral: min macOS deployment target raised 10.14 → 10.15 (the WebView plugin's
  `@available(macOS 10.15)` protocol conformance requires it under the current Xcode).
- Negative / follow-up: native OS push notifications and deep OS integration still need the
  native side to grow (they were already open in ADR-0006); the registry makes that additive.
- Negative: the app depends on network reachability of the fe2 origin (as any web client
  does); an offline/native mode is exactly what the progressive path is for.

## Alternatives considered

| Option | Why not |
|---|---|
| Keep re-implementing every screen in Flutter (ADR-0006 plan) | Produced drift and broken screens; can never guarantee pixel/button parity; endless chase of web changes. This is the concrete problem this ADR fixes. |
| Tauri / Electron web wrapper | Would also achieve 完コピ, but abandons the working Flutter macOS/Windows scaffold and, crucially, the Flutter widget layer we want for incremental native-ization. Tauri was the sanctioned fallback if Flutter could not embed a WebView; it can (`flutter_inappwebview`), so Flutter is kept. |
| Native WKWebView/WebView2 with no Flutter | Same parity, but throws away the single cross-platform codebase and the native-widget seam. |
