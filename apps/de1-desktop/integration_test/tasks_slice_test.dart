// End-to-end tasks slice, driven on the real macOS app surface:
// login -> app shell -> open the app launcher -> Tasks -> optimistic status
// change, all over real HTTP against the local mock gateway
// (tool/mock_gateway.dart).
//
// Run (mock must be listening on the port below first):
//   dart run tool/mock_gateway.dart 8799 &
//   flutter drive \
//     --driver=test_driver/integration_test.dart \
//     --target=integration_test/tasks_slice_test.dart -d macos \
//     --dart-define=GATEWAY_BASE_URL=http://127.0.0.1:8799 \
//     --dart-define=AUTO_LOGIN=true \
//     --dart-define=AUTO_LOGIN_EMAIL=demo@developershub.jp \
//     --dart-define=AUTO_LOGIN_PASSWORD=demo
//
// The captured PNG is returned to the driver via reportData (see slice_test).
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

  testWidgets('tasks: navigate -> list -> optimistic status change (live HTTP)',
      (tester) async {
    await tester.pumpWidget(
      RepaintBoundary(
        key: captureKey,
        child: const ProviderScope(child: DubDesktopApp()),
      ),
    );

    Future<bool> pumpUntil(Finder f, {int tries = 80}) async {
      for (var i = 0; i < tries; i++) {
        await tester.pump(const Duration(milliseconds: 250));
        if (f.evaluate().isNotEmpty) return true;
      }
      return false;
    }

    // Auto-login lands on the shell (notifications tab).
    expect(await pumpUntil(find.text('DAV Desktop')), isTrue,
        reason: 'shell should render after live login');

    // Open the 9-dot app launcher and switch to Tasks.
    await tester.tap(find.byTooltip('アプリ'));
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.text('タスク').last);
    await tester.pump(const Duration(milliseconds: 400));

    // The live task list renders.
    expect(await pumpUntil(find.text('北陸ITカンファレンスの会場を確定する')), isTrue,
        reason: 'tasks should load from the gateway');

    // Exactly one task starts as 未着手 (tsk_2). Change it optimistically to 完了.
    // Tapping the status chip (the PopupMenuButton's child) opens the menu.
    expect(find.text('未着手'), findsOneWidget);
    await tester.tap(find.text('未着手'));
    await tester.pump(const Duration(milliseconds: 500));
    // Tap the '完了' item in the just-opened popup menu (last in the overlay).
    await tester.tap(find.text('完了').last);
    await tester.pump(const Duration(milliseconds: 300));

    // Optimistic reflection: the 未着手 chip is gone immediately, and the change
    // survives the server round-trip (no rollback SnackBar).
    final gone = await pumpUntil(
      find.text('未着手'),
      tries: 20,
    ).then((appeared) => !appeared);
    expect(gone, isTrue, reason: '未着手 should be replaced after the change');
    expect(find.textContaining('できませんでした'), findsNothing,
        reason: 'a successful change must not roll back');

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
