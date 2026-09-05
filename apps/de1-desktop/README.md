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
  cookie store. The web bundle owns all HTTP — there is **no native API client**.
- The **only** native behaviour is the launch flow (see below). Screens can still be moved to
  native Flutter widgets later, one at a time, via the `FeatureRegistry` seam in
  `lib/feature_registry.dart` — see "漸進的ネイティブ化" in the architecture doc.

## The one native layer: biometric gate + credential autofill

Everything visible is the web app; the shell adds a single native capability on top:

1. **Launch gate** — on startup, if a credential pair has been saved and the device can
   authenticate, the OS biometric prompt (Touch ID on macOS, Windows Hello on Windows, with a
   passcode/password fallback) stands in front of the WebView. `lib/state/app_lock.dart` +
   `lib/ui/lock_screen.dart`, via `local_auth`.
2. **Autofill** — once the gate is passed, the WebView loads and a small injected page script
   fills the saved email + password into the web login form (`#fe2-login-email`,
   `#fe2-login-password`) and clicks submit. `lib/ui/web_shell.dart`.
3. **First run / capture** — with nothing saved the app opens straight to the web login; the
   user signs in by hand and the shell captures those credentials on submit and stores them in
   the OS secure store (macOS Keychain / Windows Credential Manager, via `flutter_secure_storage`,
   `lib/state/credential_store.dart`). From the next launch the gate + autofill apply.

The password only ever lives in the WebView JS context (as a browser password manager would
fill it) and in the OS secure store — never in a plain file or a log.

## Run / build

```bash
flutter pub get
flutter run -d macos          # or: flutter run -d windows
flutter build macos           # release build -> build/macos/Build/Products/…/Dub.app

# point at another environment (demo, or a local vite dev server):
flutter run -d macos --dart-define=WEB_BASE_URL=https://dub-fe2-app-shell-demo.developershub-site.workers.dev
```

macOS requires deployment target ≥ 10.15 (already configured). `apps/de1-desktop` has no
`package.json`, so it is invisible to the pnpm/turbo web build.
