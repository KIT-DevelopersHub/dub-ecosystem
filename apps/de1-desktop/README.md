# Dub — desktop/mobile client (macOS + Windows + iOS + Android)

The **Dub** desktop/mobile app for the DevHub / Dub ecosystem. It is a thin native shell that
renders the **real Web SPA** (`apps/fe2-app-shell`) inside a WebView, so the UI is a
**perfect copy (完コピ)** of the web app — same login, same 9-dot launcher, same screens,
same button positions — and it follows every web deploy automatically.

Formal decisions: **ADR-0007** (WebView clone + progressive native-ization) and ADR-0006
(Flutter framework). Design notes: `docs/desktop-flutter/ARCHITECTURE.md`.

## How it works

- The whole window is one `flutter_inappwebview` WebView pointed at the production fe2 origin
  (`https://dub-fe2-app-shell.developershub-site.workers.dev`). macOS/iOS use WKWebView,
  Windows uses WebView2, Android uses the platform WebView.
- Login and session are browser-identical: the `dub_session` cookie lives in the WebView's
  cookie store.
- There is (today) no bespoke Flutter UI beyond the biometric launch flow below. Screens can
  be moved to native Flutter widgets later, one at a time, via the `FeatureRegistry` seam in
  `lib/feature_registry.dart` — see "漸進的ネイティブ化" in the architecture doc.

### Biometric auto-login (Face ID / Touch ID / Windows Hello)

The *only* other native behaviour is an opt-in biometric launch gate + credential autofill
(`lib/state/app_lock.dart`, `lib/state/credential_store.dart`, `lib/state/autofill.dart`,
`lib/ui/lock_screen.dart`, `lib/ui/web_shell.dart`):

1. First launch: no saved credentials → the web login shows as normal; the typed email/
   password are held in memory only.
2. On a successful manual login (the web login form unmounts), a native dialog offers to
   "enable Face ID / Touch ID login". Only on explicit consent are the credentials written to
   the OS Keychain (`flutter_secure_storage`) — never to a plain file or log.
3. From the next launch on, the app shows a biometric prompt (Face ID/Touch ID on iOS,
   Touch ID on macOS, Windows Hello on Windows) before opening; on success, a JS bridge
   injected into the WebView (`#fe2-login-email` / `#fe2-login-password` /
   `[data-testid="fe2-login-form"]` / `[data-testid="fe2-login-submit"]`, see
   `apps/fe2-app-shell/src/shell/screens/LoginScreen.tsx`) fills and submits the login form.
4. Biometric failure/cancel/no-enrollment is never a dead end: the lock screen always offers
   "パスワードで通常ログインする" to fall back to a manual web login. A bottom-left settings
   button lets the user toggle autofill on/off later.

## Run / build

```bash
flutter pub get
flutter run -d macos          # or: flutter run -d windows
flutter build macos           # release build -> build/macos/Build/Products/…/Dub.app

# point at another environment (demo, or a local vite dev server):
flutter run -d macos --dart-define=WEB_BASE_URL=https://dub-fe2-app-shell-demo.developershub-site.workers.dev
```

### iOS

```bash
flutter pub get
flutter build ios --release          # signed build -> build/ios/iphoneos/Runner.app
flutter install -d <device-id>       # install to a connected/trusted iPhone
# or: flutter run -d <device-id>     # build + install + launch, attached debugger
```

Signing: Automatic (Personal Team), bundle id `jp.developershub.dubDesktop`. The device must
be connected via cable (or on the same LAN with Developer Mode + Wi-Fi debugging enabled),
unlocked, and already trusted by this Mac — `flutter devices` / `xcrun devicectl list devices`
must list it before install will work.

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
