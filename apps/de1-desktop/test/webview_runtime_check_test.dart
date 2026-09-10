// Root-cause regression test for the "opens on Windows and loads forever"
// bug: flutter_inappwebview silently never fires any callback when the
// Windows WebView2 Runtime is missing, so the shell must preflight it and
// show an actionable screen instead of hanging.
import 'package:flutter_test/flutter_test.dart';

import 'package:dub_desktop/webview_runtime_check.dart';

void main() {
  group('checkWebRuntime', () {
    test('non-Windows platforms are always available (no separate runtime)',
        () async {
      final status = await checkWebRuntime(
        isWindows: false,
        getAvailableVersion: () async =>
            throw StateError('should not be called on non-Windows'),
      );
      expect(status, WebRuntimeStatus.available);
    });

    test('Windows with an installed WebView2 Runtime is available', () async {
      final status = await checkWebRuntime(
        isWindows: true,
        getAvailableVersion: () async => '128.0.2739.42',
      );
      expect(status, WebRuntimeStatus.available);
    });

    test('Windows with no WebView2 Runtime is missingOnWindows', () async {
      final status = await checkWebRuntime(
        isWindows: true,
        getAvailableVersion: () async => null,
      );
      expect(status, WebRuntimeStatus.missingOnWindows);
    });

    test('Windows where the probe itself throws is treated as missing',
        () async {
      final status = await checkWebRuntime(
        isWindows: true,
        getAvailableVersion: () async => throw Exception('native call failed'),
      );
      expect(status, WebRuntimeStatus.missingOnWindows);
    });
  });
}
