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

### Phone (iOS / Android)

The same shell is the Dub phone app. On iOS and Android it adds what a browser
would otherwise do for the web app:

| Behaviour | How |
|---|---|
| Stay logged in | `dub_session` cookie in the WebView store (sliding session) + optional Face ID / fingerprint autofill |
| Links to other sites, `mailto:`, `tel:` | Opened in the OS browser / app (`lib/mobile/link_policy.dart`) |
| `target=_blank` / `window.open` to Dub | In-app viewer that shares the session (`lib/ui/link_viewer.dart`) |
| Downloads (`<a download>`, attachments) | OS share sheet: "Save to Files", other apps (`lib/mobile/download_bridge.dart`, `file_saver.dart`) |
| File upload / camera | The WebView's own file picker (camera/photo usage strings in `Info.plist`) |
| Back | iOS edge swipe; Android back button walks the web history, then exits |
| Push | FCM (Android, iOS via APNs). Unregistered on logout |

```bash
flutter pub get
flutter run -d <device-id>                 # debug on a connected phone
flutter build ipa --release                # iOS archive for App Store Connect
flutter build appbundle --release          # Android .aab for Google Play
flutter build apk --release                # Android APK for direct install
```

- Bundle id / application id: `jp.developershub.dubDesktop` (iOS),
  `jp.developershub.dub_desktop` (Android). Changing them requires a new Firebase app.
- iOS signing uses the Apple Developer team configured in Xcode (Automatic).
- Android release signing reads `android/key.properties` (see
  `android/key.properties.example`). Without it, release builds are signed with
  the debug key: fine for testing, rejected by Google Play.
- Android builds need JDK 17.
- App icon and launch images come from `tool/make_icons.py`.

macOS requires deployment target ≥ 10.15 (already configured). `apps/de1-desktop` has no
`package.json`, so it is invisible to the pnpm/turbo web build.
