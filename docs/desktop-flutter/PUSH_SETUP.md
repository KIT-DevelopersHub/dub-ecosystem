# Background push (FCM) — de1-desktop client setup

The Flutter client (`apps/de1-desktop`) ships the full background-push receiver
(permission -> FCM token -> register with mobile-bff -> foreground/background/
terminated handling). What it deliberately does **not** ship is the
**project-specific Firebase config**, which is a credential and is `.gitignore`d.
Until those files are added, push initialises to a **no-op** (the app runs
normally; `Firebase.initializeApp()` throws and is caught).

Server side is already live (mo3-mobile-bff, FCM一本化): tokens registered here
receive real pushes with no further backend work.

## Contract (already implemented, no action needed)

| Piece | Value |
|---|---|
| Register endpoint | `POST https://m-api.developershub.jp/m/v1/devices` |
| Body | `{ "platform": "android"\|"ios"\|"macos", "pushToken": "<fcm token>" }` |
| Auth | `Authorization: Bearer <dub_session token>` (read from the cookie jar) |
| Response | `201 { "deviceId": "..." }` |
| Unregister | `DELETE /m/v1/devices/:deviceId` (on logout) |

Transport by platform: android/ios/macOS → FCM; **Windows → WNS (no Flutter FCM
plugin; see "Windows" below)**.

## What YOU must add (credentials — never commit)

Run **`flutterfire configure`** in `apps/de1-desktop` against the Dub Firebase
project (create one in the Firebase console if it does not exist — reuse the
existing GA/Firebase project from 判断62 if applicable). It generates and places:

| File | Platform | Path |
|---|---|---|
| `firebase_options.dart` | all | `lib/firebase_options.dart` |
| `google-services.json` | Android | `android/app/google-services.json` |
| `GoogleService-Info.plist` | iOS/macOS | `ios/Runner/` and `macos/Runner/` |

All four are already in `.gitignore`. Do **not** commit them.

### Android (the $0 path — do this first)

1. Firebase console → add an **Android app**, package name
   `jp.developershub.dub_desktop`. Download `google-services.json` →
   `android/app/`.
2. Wire the Google Services Gradle plugin (kept OUT of the repo so the build
   stays green without the json):
   - `android/settings.gradle.kts` `plugins { }` block, add:
     `id("com.google.gms.google-services") version "4.4.2" apply false`
   - `android/app/build.gradle.kts` `plugins { }` block, add:
     `id("com.google.gms.google-services")`
3. `flutter run -d <android device>` — grant the notification prompt.
4. Send a test from Firebase console (Cloud Messaging) or via the mobile-bff.

Nothing else is required: `minSdk` is already ≥23, `POST_NOTIFICATIONS` is
declared, and the notification channel + tap handling are built in.

### iOS / macOS (needs a paid Apple Developer account)

FCM on Apple platforms delivers via APNs, so this requires:
- An **Apple Developer Program** membership (paid) and an **APNs Auth Key
  (.p8)** uploaded to Firebase → Project Settings → Cloud Messaging.
- The **Push Notifications** capability + `aps-environment` entitlement in
  Xcode (add to `macos/Runner/*.entitlements` and the iOS Runner target).
- `GoogleService-Info.plist` placed via `flutterfire configure`.
- (iOS only) an `ios/` platform folder — add with
  `flutter create --platforms=ios .` if you decide to ship iOS from this app.

The client code path is identical to Android; only the Apple credentials +
entitlements are the gate. Implemented but **not distribution-tested** (no paid
Apple account at build time).

### Windows — 別途 (separate track)

`firebase_messaging` has **no Windows implementation**, so there is no FCM token
to register on Windows; `currentPushPlatform()` returns null and the client
skips registration cleanly. The server already speaks **WNS** for Windows, but
acquiring a WNS channel URI needs native Win32/WinRT code (a platform channel or
FFI bridge) plus a Microsoft Partner Center app identity. That bridge is a
separate task and is intentionally not in this PR.

## How it behaves without config

- `PUSH_ENABLED` defaults true; set `--dart-define=PUSH_ENABLED=false` to force
  off (e.g. the screenshot harness).
- No Firebase files → `init()` logs and returns; the app is unaffected.
- Windows → skipped by platform check.

## Files (client implementation)

- `lib/push/push_service.dart` — Firebase/messaging lifecycle, local
  notifications, foreground/background/terminated + tap deep-link seam.
- `lib/push/push_registration.dart` — registers/refreshes the token with the
  mobile-bff; unregisters on logout.
- `lib/push/mobile_bff_client.dart` — `/m/v1/devices` client (Bearer auth).
- `lib/push/push_platform.dart` — OS → MobilePlatform resolution.
