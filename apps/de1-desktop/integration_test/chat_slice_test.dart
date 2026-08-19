// End-to-end chat slice, driven on the real macOS app surface:
// auto-login -> app shell -> chat (channels + history) -> optimistic send ->
// realtime receive over the DO-direct WebSocket — all over real HTTP/WS against
// the local mock gateway (tool/mock_gateway.dart).
//
// Run (mock must be listening on the port below first):
//   flutter drive \
//     --driver=test_driver/chat_integration_test.dart \
//     --target=integration_test/chat_slice_test.dart -d macos \
//     --dart-define=GATEWAY_BASE_URL=http://127.0.0.1:8799 \
//     --dart-define=AUTO_LOGIN=true \
//     --dart-define=AUTO_LOGIN_EMAIL=demo@developershub.jp \
//     --dart-define=AUTO_LOGIN_PASSWORD=demo
//
// Captured PNGs are sent back to the driver via reportData (RepaintBoundary
// snapshot — macOS integration_test has no native takeScreenshot channel).
import 'dart:convert';
import 'dart:ui' as ui;

import 'package:dub_desktop/main.dart';
import 'package:dub_desktop/ui/app_shell.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  final captureKey = GlobalKey();
  final shots = <String, dynamic>{};

  Future<void> capture(WidgetTester tester, String name) async {
    await tester.pump(const Duration(milliseconds: 300));
    final boundary =
        captureKey.currentContext!.findRenderObject() as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: 2.0);
    final byteData = await image.toByteData(format: ui.ImageByteFormat.png);
    shots['${name}_b64'] = base64Encode(byteData!.buffer.asUint8List());
  }

  Future<bool> pumpUntil(WidgetTester tester, Finder finder,
      {int tries = 80}) async {
    for (var i = 0; i < tries; i++) {
      await tester.pump(const Duration(milliseconds: 250));
      if (finder.evaluate().isNotEmpty) return true;
    }
    return false;
  }

  testWidgets('chat: login -> channels -> send -> realtime receive',
      (tester) async {
    await tester.pumpWidget(
      RepaintBoundary(
        key: captureKey,
        child: ProviderScope(
          // Open directly on the chat feature after auto-login.
          overrides: [selectedFeatureProvider.overrideWith((ref) => 'chat')],
          child: const DubDesktopApp(),
        ),
      ),
    );

    // 1) Channels + seeded history render (auto-login -> /me -> channels -> messages).
    final seeded =
        find.text('おはようございます！今日のリリースレビュー 15:00 からです。');
    expect(await pumpUntil(tester, seeded), isTrue,
        reason: 'seeded channel history should render after login');
    expect(find.text('general'), findsWidgets);
    await capture(tester, 'chat-01-channels');

    // 2) Optimistic send.
    const mine = 'DAV デスクトップから送信しています！';
    await tester.enterText(find.byType(TextField), mine);
    await tester.pump(const Duration(milliseconds: 100));
    await tester.tap(find.widgetWithIcon(FilledButton, Icons.send));
    expect(await pumpUntil(tester, find.text(mine)), isTrue,
        reason: 'sent message should appear optimistically');
    await capture(tester, 'chat-02-sent');

    // 3) Realtime receive: the mock pushes an inbound message over the WebSocket
    //    ~1.5s after the socket connects.
    final live = find.text('これはリアルタイム受信のデモです（WebSocket 経由）📡');
    expect(await pumpUntil(tester, live, tries: 120), isTrue,
        reason: 'inbound message should arrive over the WebSocket');
    await capture(tester, 'chat-03-realtime');

    binding.reportData = shots;
  });
}
