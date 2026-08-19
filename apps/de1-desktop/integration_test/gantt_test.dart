// End-to-end gantt slice on the real macOS app surface:
// login (email+password) -> session cookie -> gantt screen rendered from the
// live gantt-service routes, all over real HTTP against tool/mock_gateway.dart.
//
// Run (mock must be listening on the port below first):
//   flutter drive \
//     --driver=test_driver/integration_test.dart \
//     --target=integration_test/gantt_test.dart -d macos \
//     --dart-define=GATEWAY_BASE_URL=http://127.0.0.1:8799 \
//     --dart-define=AUTO_LOGIN=true \
//     --dart-define=AUTO_LOGIN_EMAIL=demo@developershub.jp \
//     --dart-define=AUTO_LOGIN_PASSWORD=demo
//
// Starts on the gantt app (selectedAppProvider override) so the chart is what
// gets snapshotted. Screenshot -> integration_test/screenshots/gantt-desktop.png.
import 'dart:convert';
import 'dart:ui' as ui;

import 'package:dub_desktop/main.dart';
import 'package:dub_desktop/ui/app_shell.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  final captureKey = GlobalKey();

  testWidgets('login -> gantt chart renders (live HTTP)', (tester) async {
    await tester.pumpWidget(
      RepaintBoundary(
        key: captureKey,
        child: ProviderScope(
          // Land directly on the gantt app so the chart is what we verify.
          overrides: [
            selectedAppProvider.overrideWith((ref) => 'gantt'),
          ],
          child: const DubDesktopApp(),
        ),
      ),
    );

    // Poll until a live gantt row (from the mock chart) renders.
    final target = find.text('会場・登壇者調整');
    var found = false;
    for (var i = 0; i < 80; i++) {
      await tester.pump(const Duration(milliseconds: 250));
      if (target.evaluate().isNotEmpty) {
        found = true;
        break;
      }
    }
    expect(found, isTrue,
        reason: 'a gantt row should render after live login + fetch');
    expect(find.text('ガント'), findsWidgets);

    await tester.pump(const Duration(milliseconds: 400));

    final boundary =
        captureKey.currentContext!.findRenderObject() as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: 2.0);
    final byteData = await image.toByteData(format: ui.ImageByteFormat.png);
    binding.reportData = <String, dynamic>{
      'name': 'gantt-desktop',
      'screenshot_b64': base64Encode(byteData!.buffer.asUint8List()),
    };
  });
}
