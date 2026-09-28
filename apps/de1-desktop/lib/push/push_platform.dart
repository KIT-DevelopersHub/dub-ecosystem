import 'dart:io' show Platform;

/// Resolves the running OS to the `MobilePlatform` string the mobile-bff
/// `/m/v1/devices` contract accepts (`ios | android | macos | windows`).
///
/// Push transport by platform (server side, mo3-mobile-bff):
///   * android / ios / macos  -> FCM (Apple tokens forwarded to APNs by Firebase)
///   * windows                -> WNS (no firebase_messaging support; see below)
///
/// Returns null for Windows and any other OS: `firebase_messaging` has no
/// Windows implementation, so the FCM registration path is skipped there. A
/// native WNS channel-URI bridge would be needed to register a Windows device
/// (tracked in docs/desktop-flutter/PUSH_SETUP.md — "Windows は別途").
String? currentPushPlatform() {
  if (Platform.isAndroid) return 'android';
  if (Platform.isIOS) return 'ios';
  if (Platform.isMacOS) return 'macos';
  // Platform.isWindows and everything else: no FCM client transport.
  return null;
}

/// Whether the FCM (firebase_messaging) client transport exists for this OS.
bool get isFcmSupportedPlatform => currentPushPlatform() != null;
