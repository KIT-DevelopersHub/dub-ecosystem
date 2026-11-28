import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show kIsWeb;

/// App version shown to the web (feedback device context). The defaults must
/// match `version:` in pubspec.yaml (test/app_identity_test.dart fails when they
/// drift). A build that overrides `--build-name/--build-number` should pass the
/// same values as `--dart-define=DUB_APP_VERSION=… --dart-define=DUB_APP_BUILD=…`.
const String kAppVersion = String.fromEnvironment('DUB_APP_VERSION', defaultValue: '1.0.2');
const String kAppBuild = String.fromEnvironment('DUB_APP_BUILD', defaultValue: '3');

/// `ios` / `android` / `macos` / `windows` (the platforms the web understands).
String? dubAppPlatform() {
  if (kIsWeb) return null;
  if (Platform.isIOS) return 'ios';
  if (Platform.isAndroid) return 'android';
  if (Platform.isMacOS) return 'macos';
  if (Platform.isWindows) return 'windows';
  return null;
}

/// The mark appended to the WebView UA so the web knows it runs inside the Dub
/// app: `DubApp/<platform> <version> (<build>)` (contract:
/// `notification.DUB_APP_UA_TOKEN` in packages/types).
String dubAppUserAgentMark({String? platform}) {
  final p = platform ?? dubAppPlatform() ?? 'unknown';
  return 'DubApp/$p $kAppVersion ($kAppBuild)';
}
