# Dub — desktop client (macOS + Windows)

The **Dub** desktop app for the DevHub / Dub ecosystem. It is a thin native shell that
renders the **real Web SPA** (`apps/fe2-app-shell`) inside a WebView, so the desktop UI is a
**perfect copy (完コピ)** of the web app — same login, same 9-dot launcher, same screens,
same button positions — and it follows every web deploy automatically.

Formal decisions: **ADR-0007** (WebView clone + progressive native-ization) and ADR-0006
(Flutter framework). Design notes: `docs/desktop-flutter/ARCHITECTURE.md`.

## How it works

- The whole window is one `flutter_inappwebview` WebView pointed at the production fe2 origin
  (`https://dub-fe2-app-shell.developershub-site.workers.dev`). macOS uses WKWebView, Windows
  uses WebView2.
- Login and session are browser-identical: the `dub_session` cookie lives in the WebView's
  cookie store. The shell handles no credentials.
- There is (today) no bespoke Flutter UI. Screens can be moved to native Flutter widgets
  later, one at a time, via the `FeatureRegistry` seam in `lib/feature_registry.dart` — see
  "漸進的ネイティブ化" in the architecture doc.

## Run / build

```bash
flutter pub get
flutter run -d macos          # or: flutter run -d windows
flutter build macos           # release build -> build/macos/Build/Products/…/Dub.app

# point at another environment (demo, or a local vite dev server):
flutter run -d macos --dart-define=WEB_BASE_URL=https://dub-fe2-app-shell-demo.developershub-site.workers.dev
```

### Android (experimental — same WebView shell on a phone)

The same shell also runs on Android; the SPA has a `width=device-width` viewport and
responsive breakpoints, so it reflows to a mobile layout (login renders cleanly). It is
usable but not mobile-first: data-dense views (Gantt, roster tables, mail/chat) are
cramped and scroll horizontally, so this is for internal testing/sharing, not an end-user
mobile product. Requires JDK 17 (Flutter 3.29's Gradle plugin rejects newer JDKs).

```bash
flutter build apk --release                  # universal APK (all devices)
flutter build apk --release --split-per-abi  # smaller per-ABI APKs
# APK -> build/app/outputs/flutter-apk/app-release.apk
```

APKs are **debug-signed** (no release keystore): Android will warn on install and they
must not go to a store. To install, enable "unknown sources" and open the APK.

macOS requires deployment target ≥ 10.15 (already configured). `apps/de1-desktop` has no
`package.json`, so it is invisible to the pnpm/turbo web build.
