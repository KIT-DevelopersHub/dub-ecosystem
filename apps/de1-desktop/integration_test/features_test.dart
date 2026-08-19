// End-to-end feature walk on the real macOS app surface: login -> shell, then
// navigate to Events, Drive and Settings, each fetched over real HTTP against
// the local mock gateway (tool/mock_gateway.dart). Captures one app-surface
// screenshot per feature and ships them back to the driver via reportData.
//
// Run (mock must be listening on the port below first):
//   flutter drive \
//     --driver=test_driver/integration_test.dart \
//     --target=integration_test/features_test.dart -d macos \
//     --dart-define=GATEWAY_BASE_URL=http://127.0.0.1:8799 \
//     --dart-define=AUTO_LOGIN=true \
//     --dart-define=AUTO_LOGIN_EMAIL=demo@developershub.jp \
//     --dart-define=AUTO_LOGIN_PASSWORD=demo
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
  final shots = <String, dynamic>{};

  Future<bool> pumpUntil(WidgetTester tester, Finder finder,
      {int tries = 80}) async {
    for (var i = 0; i < tries; i++) {
      await tester.pump(const Duration(milliseconds: 250));
      if (finder.evaluate().isNotEmpty) return true;
    }
    return false;
  }

  Future<String> capture() async {
    await Future<void>.delayed(const Duration(milliseconds: 300));
    final boundary =
        captureKey.currentContext!.findRenderObject() as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: 2.0);
    final byteData = await image.toByteData(format: ui.ImageByteFormat.png);
    return base64Encode(byteData!.buffer.asUint8List());
  }

  Future<void> openLauncherApp(WidgetTester tester, String label) async {
    await tester.tap(find.byIcon(Icons.apps));
    await tester.pumpAndSettle();
    await tester.tap(find.text(label).last);
    await tester.pumpAndSettle();
  }

  testWidgets('login -> events / drive / settings (live HTTP)',
      (tester) async {
    await tester.pumpWidget(
      RepaintBoundary(
        key: captureKey,
        child: const ProviderScope(child: DubDesktopApp()),
      ),
    );

    // Wait for the shell (the vertical-slice inbox item renders post-login).
    final booted =
        await pumpUntil(tester, find.text('使用量ダッシュボードを全メンバーに開放しました'));
    expect(booted, isTrue, reason: 'shell should render after live login');

    // --- Events ---
    await openLauncherApp(tester, 'イベント');
    final eventsOk =
        await pumpUntil(tester, find.text('北陸ITカンファレンス 2026'));
    expect(eventsOk, isTrue, reason: 'events list should render live');
    shots['events_b64'] = await capture();

    // --- Drive ---
    await openLauncherApp(tester, 'ドライブ');
    final driveOk = await pumpUntil(tester, find.text('イベント資料'));
    expect(driveOk, isTrue, reason: 'drive list should render live');
    shots['drive_b64'] = await capture();

    // --- Settings (from the account menu) ---
    await tester.tap(find.byType(PopupMenuButton<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('設定').last);
    await tester.pumpAndSettle();
    final settingsOk = await pumpUntil(tester, find.text('パスワードを変更'));
    expect(settingsOk, isTrue, reason: 'settings/profile should render');
    shots['settings_b64'] = await capture();

    binding.reportData = shots;
  });
}
