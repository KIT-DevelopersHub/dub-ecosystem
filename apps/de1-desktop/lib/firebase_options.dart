// Hand-written equivalent of a `flutterfire configure` output, scoped to the
// platforms this desktop app actually ships (Android = FCM, macOS = FCM over
// APNs for push-notification testing). Values pulled from the existing
// Firebase project "dub-ecosystem" (already used by mo3-mobile-bff's FCM
// sender, see apps/mo3-mobile-bff/src/fcm.ts) via:
//   firebase apps:list --project dub-ecosystem
//   firebase apps:sdkconfig <ANDROID|IOS> <appId> --project dub-ecosystem
//
// These are Firebase **client** identifiers (API_KEY here is the public
// per-app Firebase Web/iOS key, not a server secret — see
// https://firebase.google.com/docs/projects/api-keys). It is fine for this to
// live in the client source tree, exactly like the VAPID public key used
// elsewhere in the ecosystem.
//
// Passing these explicitly to `Firebase.initializeApp(options: ...)` avoids
// needing `GoogleService-Info.plist` wired into the Xcode "Copy Bundle
// Resources" build phase — the Dart-side options are sufficient for
// firebase_core / firebase_messaging on macOS and Android alike.
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart'
    show TargetPlatform, defaultTargetPlatform, kIsWeb;

class DefaultFirebaseOptions {
  DefaultFirebaseOptions._();

  static FirebaseOptions get currentPlatform {
    if (kIsWeb) {
      throw UnsupportedError(
        'DefaultFirebaseOptions has not been configured for web — '
        'de1-desktop does not ship a web build.',
      );
    }
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return android;
      case TargetPlatform.macOS:
        return macos;
      default:
        throw UnsupportedError(
          'DefaultFirebaseOptions has not been configured for '
          '$defaultTargetPlatform — de1-desktop push is Android + macOS only '
          '(see lib/push/fcm_push.dart FcmPush.isSupported).',
        );
    }
  }

  /// Firebase app: "dub_desktop (android)" — 1:66069265591:android:e6c413fa84676959356132
  static const android = FirebaseOptions(
    apiKey: 'AIzaSyBga4n4fGd8y3WxETxFIAZx9JG-oZC7dP4',
    appId: '1:66069265591:android:e6c413fa84676959356132',
    messagingSenderId: '66069265591',
    projectId: 'dub-ecosystem',
    storageBucket: 'dub-ecosystem.firebasestorage.app',
  );

  /// Firebase app: "dub_desktop (macos)" — registered on the IOS platform in
  /// Firebase (bundle jp.developershub.dubDesktop) — 1:66069265591:ios:280782ce46eca9b2356132
  static const macos = FirebaseOptions(
    apiKey: 'AIzaSyCFYztT4fF_3vtG4YhAeaurTlhyU6wzx7U',
    appId: '1:66069265591:ios:280782ce46eca9b2356132',
    messagingSenderId: '66069265591',
    projectId: 'dub-ecosystem',
    storageBucket: 'dub-ecosystem.firebasestorage.app',
    iosBundleId: 'jp.developershub.dubDesktop',
  );
}
