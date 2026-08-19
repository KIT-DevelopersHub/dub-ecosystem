// End-to-end roster slice, driven on the real macOS app surface:
// login (auto) -> app shell -> open the 9-dot launcher -> tap 名簿 -> the member
// roster + role chips + Email Routing addresses render, all over real HTTP
// against the local mock gateway (tool/mock_gateway.dart).
//
// Run (mock must be listening on the port below first):
//   dart run tool/mock_gateway.dart 8799 &
//   flutter drive \
//     --driver=test_driver/integration_test.dart \
//     --target=integration_test/roster_test.dart -d macos \
//     --dart-define=GATEWAY_BASE_URL=http://127.0.0.1:8799 \
//     --dart-define=AUTO_LOGIN=true \
//     --dart-define=AUTO_LOGIN_EMAIL=demo@developershub.jp \
//     --dart-define=AUTO_LOGIN_PASSWORD=demo
//
// The captured PNG is returned to the driver via reportData (same mechanism as
// slice_test.dart), which writes it under integration_test/screenshots/.
import 'dart:convert';
import 'dart:ui' as ui;

import 'package:dub_desktop/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  final captureKey = GlobalKey();

  Future<bool> pumpUntil(WidgetTester tester, Finder finder,
      {int tries = 80}) async {
    for (var i = 0; i < tries; i++) {
      await tester.pump(const Duration(milliseconds: 250));
      if (finder.evaluate().isNotEmpty) return true;
    }
    return false;
  }

  testWidgets('login -> shell -> roster (members + roles + email routing)',
      (tester) async {
    await tester.pumpWidget(
      RepaintBoundary(
        key: captureKey,
        child: const ProviderScope(child: DubDesktopApp()),
      ),
    );

    // Auto-login lands on the shell.
    expect(await pumpUntil(tester, find.text('DAV Desktop')), isTrue,
        reason: 'app shell should render after live auto-login');

    // Open the 9-dot app launcher and choose 名簿 (roster).
    await tester.tap(find.byIcon(Icons.apps));
    await tester.pump(const Duration(milliseconds: 400));
    expect(await pumpUntil(tester, find.text('名簿')), isTrue,
        reason: 'launcher should list the 名簿 app');
    await tester.tap(find.text('名簿').last);
    await tester.pump(const Duration(milliseconds: 400));

    // The member roster resolves over HTTP: a member name + a joined role name.
    expect(await pumpUntil(tester, find.text('デモ 太郎')), isTrue,
        reason: 'roster member should render after live /identity/users fetch');
    expect(find.text('管理者'), findsWidgets,
        reason: 'role id should be joined to its human name via /identity/roles');

    // Capture the headline view (members + role chips) before scrolling.
    await tester.pump(const Duration(milliseconds: 400));
    final boundary =
        captureKey.currentContext!.findRenderObject() as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: 2.0);
    final byteData = await image.toByteData(format: ui.ImageByteFormat.png);
    binding.reportData = <String, dynamic>{
      'screenshot_b64': base64Encode(byteData!.buffer.asUint8List()),
      'screenshot_name': 'roster-members-roles',
    };

    // Scroll down to the Email Routing ("メール名簿") section — it is lazily
    // built by the ListView, so it must be scrolled into view before asserting.
    await tester.scrollUntilVisible(
      find.text('メール転送先 (Email Routing)'),
      300,
      scrollable: find.byType(Scrollable).last,
    );
    expect(find.text('メール転送先 (Email Routing)'), findsWidgets);
    expect(await pumpUntil(tester, find.text('taro.personal@gmail.com')), isTrue,
        reason: 'email routing address should render after live fetch');
  });
}
