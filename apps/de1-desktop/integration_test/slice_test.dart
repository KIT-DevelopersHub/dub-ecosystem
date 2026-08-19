// End-to-end vertical slice, driven on the real macOS app surface:
// login (email+password) -> session cookie -> app shell -> notification inbox,
// all over real HTTP against the local mock gateway (tool/mock_gateway.dart).
//
// Run (mock must be listening on the port below first):
//   flutter drive \
//     --driver=test_driver/integration_test.dart \
//     --target=integration_test/slice_test.dart -d macos \
//     --dart-define=GATEWAY_BASE_URL=http://127.0.0.1:8799 \
//     --dart-define=AUTO_LOGIN=true \
//     --dart-define=AUTO_LOGIN_EMAIL=demo@developershub.jp \
//     --dart-define=AUTO_LOGIN_PASSWORD=demo
//
// The captured PNG is sent back to the (non-sandboxed) driver via reportData,
// which writes it to integration_test/screenshots/. macOS integration_test does
// not implement the native takeScreenshot channel, so we snapshot a
// RepaintBoundary instead — in-process, app-surface only.
import 'dart:convert';
import 'dart:ui' as ui;

import 'package:dub_desktop/main.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  final captureKey = GlobalKey();

  testWidgets('login -> shell -> notification inbox (live HTTP)',
      (tester) async {
    await tester.pumpWidget(
      RepaintBoundary(
        key: captureKey,
        child: const ProviderScope(child: DubDesktopApp()),
      ),
    );

    // Poll the real widget tree until the first live inbox item renders
    // (auto-login posts credentials, then /me and /inbox resolve over HTTP).
    final target = find.text('使用量ダッシュボードを全メンバーに開放しました');
    var found = false;
    for (var i = 0; i < 80; i++) {
      await tester.pump(const Duration(milliseconds: 250));
      if (target.evaluate().isNotEmpty) {
        found = true;
        break;
      }
    }
    expect(found, isTrue,
        reason: 'inbox item should render after live login + fetch');
    expect(find.text('DAV Desktop'), findsWidgets);

    await tester.pump(const Duration(milliseconds: 400));

    final boundary =
        captureKey.currentContext!.findRenderObject() as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: 2.0);
    final byteData = await image.toByteData(format: ui.ImageByteFormat.png);
    binding.reportData = <String, dynamic>{
      'screenshot_b64': base64Encode(byteData!.buffer.asUint8List()),
    };
  });
}
