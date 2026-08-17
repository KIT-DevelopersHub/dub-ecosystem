import 'dart:io';
import 'dart:ui' as ui;

import 'package:dt1_desktop/src/app/root_app.dart';
import 'package:dt1_desktop/src/app/services.dart';
import 'package:dt1_desktop/src/config/app_config.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support/fake_gateway_adapter.dart';

/// Headless end-to-end: boots the WHOLE app against an in-memory seeded backend
/// and drives the real journey — sign in, then open every live app and assert
/// real data rendered. Exercises the actual auth flow, the generated
/// /me + /bff/home client and the tasks/gantt/notifications/events proxy repos.
/// Writes a PNG of each screen to `screenshots/` for review (a system CJK font
/// is loaded so Japanese renders instead of tofu boxes).
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    // Render real Japanese in the captured PNGs: load a system CJK font under the
    // default families the theme uses. Best-effort — the assertions don't depend
    // on it, only the screenshot legibility does.
    for (final path in const [
      '/System/Library/Fonts/ヒラギノ角ゴシック W4.ttc',
      '/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc',
      '/System/Library/Fonts/Hiragino Sans GB.ttc',
    ]) {
      final f = File(path);
      if (!f.existsSync()) continue;
      final bytes = f.readAsBytesSync().buffer.asByteData();
      // Override the default Material family so all text (incl. Japanese) uses
      // the CJK font in the captured PNGs.
      for (final family in const ['Roboto', '.SF Pro Text', '.SF Pro Display']) {
        try {
          final loader = FontLoader(family)..addFont(Future.value(bytes));
          await loader.load();
        } catch (_) {/* ignore */}
      }
      break;
    }
  });

  final shotKey = GlobalKey();

  Future<void> shot(WidgetTester tester, String name) async {
    try {
      final dir = Directory('screenshots')..createSync(recursive: true);
      final boundary =
          shotKey.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      // toImage does real raster work the fake-async test clock cannot drive —
      // it must run in a real async zone or it hangs forever.
      await tester.runAsync(() async {
        final image = await boundary.toImage(pixelRatio: 2.0);
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        File('${dir.path}/$name.png').writeAsBytesSync(bytes!.buffer.asUint8List());
      });
    } catch (_) {
      // Screenshot capture is a best-effort artifact; never fail the E2E on it.
    }
  }

  testWidgets('sign in, then every live app shows real data', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1280, 800));
    final services = AppServices.bootstrap(
      const AppConfig(apiBaseUrl: 'https://fake.local'),
      adapter: FakeGatewayAdapter(),
    );
    await tester.pumpWidget(RepaintBoundary(key: shotKey, child: DubDesktopApp(services: services)));
    await tester.pumpAndSettle();

    // 1) Login screen first.
    expect(find.text('DevHub Desktop'), findsOneWidget);
    expect(find.text('サインイン'), findsOneWidget);
    await shot(tester, '01_login');

    await tester.enterText(find.byType(TextFormField).at(0), 'demo@developershub.jp');
    await tester.enterText(find.byType(TextFormField).at(1), 'password');
    await tester.tap(find.widgetWithText(FilledButton, 'サインイン'));
    await tester.pumpAndSettle();

    // 2) Home dashboard (typed /bff/home): events + unread count.
    expect(find.text('北陸ITカンファレンス'), findsWidgets);
    expect(find.textContaining('高岡 己太朗'), findsWidgets);
    expect(find.text('近日のイベント'), findsWidgets);
    await shot(tester, '02_home');

    // 3) Notifications (proxy inbox).
    await tester.tap(find.text('通知').first);
    await tester.pumpAndSettle();
    expect(find.text('タスクが割り当てられました'), findsOneWidget);
    await shot(tester, '03_notifications');

    // 4) My tasks (proxy /tasks?assigneeId=).
    await tester.tap(find.text('マイタスク').first);
    await tester.pumpAndSettle();
    expect(find.text('基調講演の準備'), findsWidgets);
    await shot(tester, '04_tasks');

    // 5) Events (proxy /events).
    await tester.tap(find.text('イベント').first);
    await tester.pumpAndSettle();
    expect(find.text('Hackit 2026'), findsWidgets);
    await shot(tester, '05_events');

    // 6) Gantt (proxy /gantt?eventId=): rows render with progress.
    await tester.tap(find.text('ガントチャート').first);
    await tester.pumpAndSettle();
    expect(find.textContaining('会場設営の手配'), findsWidgets);
    await shot(tester, '06_gantt');

    // 7) Profile (typed /me): permissions surface + sign-out.
    await tester.tap(find.text('プロフィール').first);
    await tester.pumpAndSettle();
    expect(find.text('event:read'), findsOneWidget);
    await shot(tester, '07_profile');
    expect(find.text('サインアウト'), findsOneWidget);

    // 8) Sign out returns to the login screen.
    await tester.tap(find.text('サインアウト'));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(FilledButton, 'サインイン'), findsOneWidget);

    // Restore for any later tests.
    await tester.binding.setSurfaceSize(null);
  });
}
