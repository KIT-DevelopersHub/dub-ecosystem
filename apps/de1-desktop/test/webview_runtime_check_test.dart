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

  group('resolveWindowsUserDataFolder', () {
    // Root-cause regression test for the follow-up bug: WebView2 Runtime IS
    // installed, yet the app still hangs/times out because the default (null)
    // userDataFolder resolves to a subfolder of the app's own install
    // directory, which is unwritable when installed under Program Files.

    test('non-Windows platforms need no override', () {
      final folder = resolveWindowsUserDataFolder(
        isWindows: false,
        localAppData: r'C:\Users\someone\AppData\Local',
        temp: r'C:\Users\someone\AppData\Local\Temp',
      );
      expect(folder, isNull);
    });

    test('Windows uses %LOCALAPPDATA%\\Dub\\WebView2 when available', () {
      final folder = resolveWindowsUserDataFolder(
        isWindows: true,
        localAppData: r'C:\Users\someone\AppData\Local',
        temp: r'C:\Users\someone\AppData\Local\Temp',
      );
      expect(folder, r'C:\Users\someone\AppData\Local\Dub\WebView2');
    });

    test('Windows falls back to %TEMP% when LOCALAPPDATA is unset', () {
      final folder = resolveWindowsUserDataFolder(
        isWindows: true,
        localAppData: null,
        temp: r'C:\Users\someone\AppData\Local\Temp',
      );
      expect(folder, r'C:\Users\someone\AppData\Local\Temp\Dub\WebView2');
    });

    test('Windows falls back to %TEMP% when LOCALAPPDATA is empty', () {
      final folder = resolveWindowsUserDataFolder(
        isWindows: true,
        localAppData: '',
        temp: r'C:\Temp',
      );
      expect(folder, r'C:\Temp\Dub\WebView2');
    });

    test('Windows returns null when neither env var is available', () {
      final folder = resolveWindowsUserDataFolder(
        isWindows: true,
        localAppData: null,
        temp: null,
      );
      expect(folder, isNull);
    });
  });
}
