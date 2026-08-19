// End-to-end mail slice, driven on the real macOS app surface:
// login (auto) -> shell booted into Mail (INITIAL_APP=mail) -> live inbox list
// -> open a message (thread conversation + optimistic 既読) -> compose -> save
// draft (下書き). All reads go over real HTTP against the local mock gateway
// (tool/mock_gateway.dart).
//
// Run (mock must be listening on the port below first):
//   dart run tool/mock_gateway.dart 8799 &
//   flutter drive \
//     --driver=test_driver/integration_test.dart \
//     --target=integration_test/mail_slice_test.dart -d macos \
//     --dart-define=GATEWAY_BASE_URL=http://127.0.0.1:8799 \
//     --dart-define=INITIAL_APP=mail \
//     --dart-define=AUTO_LOGIN=true \
//     --dart-define=AUTO_LOGIN_EMAIL=demo@developershub.jp \
//     --dart-define=AUTO_LOGIN_PASSWORD=demo
//
// Screenshots are sent back to the driver via reportData (a name->b64 map),
// which writes them to integration_test/screenshots/. macOS integration_test
// does not implement the native takeScreenshot channel, so we snapshot a
// RepaintBoundary around the app surface instead.
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
  final shots = <String, String>{};

  Future<String> snapshot() async {
    await Future<void>.delayed(const Duration(milliseconds: 200));
    final boundary =
        captureKey.currentContext!.findRenderObject() as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: 2.0);
    final byteData = await image.toByteData(format: ui.ImageByteFormat.png);
    return base64Encode(byteData!.buffer.asUint8List());
  }

  Future<bool> pumpUntil(WidgetTester tester, Finder finder,
      {int tries = 80}) async {
    for (var i = 0; i < tries; i++) {
      await tester.pump(const Duration(milliseconds: 250));
      if (finder.evaluate().isNotEmpty) return true;
    }
    return false;
  }

  testWidgets('mail: login -> inbox -> thread (既読) -> save draft (live HTTP)',
      (tester) async {
    await tester.pumpWidget(
      RepaintBoundary(
        key: captureKey,
        child: const ProviderScope(child: DubDesktopApp()),
      ),
    );

    // 1) Inbox renders live from GET /api/v1/mail/messages.
    const firstSubject = '北陸ITカンファレンスの協賛について';
    final inboxItem = find.text(firstSubject);
    expect(await pumpUntil(tester, inboxItem), isTrue,
        reason: 'inbox message should render after live login + fetch');
    expect(find.text('DAV Desktop'), findsWidgets);
    expect(find.text('受信トレイ'), findsWidgets);
    shots['mail-01-inbox'] = await snapshot();

    // 2) Open the message -> reading pane loads the thread conversation and the
    //    tap marks it read (optimistic). Thread mthr_1 has two messages.
    await tester.tap(inboxItem.first);
    await tester.pump(const Duration(milliseconds: 300));
    final threadReply = find.text('Re: 北陸ITカンファレンスの協賛について');
    expect(await pumpUntil(tester, threadReply), isTrue,
        reason: 'thread conversation should render in the reading pane');
    shots['mail-02-thread'] = await snapshot();

    // 3) Compose -> fill -> save draft (optimistic). No send in this slice.
    await tester.tap(find.byKey(const Key('mail-compose-button')));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byKey(const Key('mail-compose-save')), findsOneWidget);
    await tester.enterText(
        find.byKey(const Key('mail-compose-to')), 'sato@example.com');
    await tester.enterText(
        find.byKey(const Key('mail-compose-subject')), 'ご協賛ありがとうございます');
    await tester.enterText(
        find.byKey(const Key('mail-compose-body')), '詳細を添付いたします。');
    await tester.pump(const Duration(milliseconds: 200));
    shots['mail-03-compose'] = await snapshot();

    await tester.tap(find.byKey(const Key('mail-compose-save')));
    await tester.pump(const Duration(milliseconds: 400));
    // Saving switches to the 下書き folder; the draft subject shows in the list.
    final draftRow = find.text('ご協賛ありがとうございます');
    expect(await pumpUntil(tester, draftRow, tries: 20), isTrue,
        reason: 'saved draft should appear in the 下書き folder');
    shots['mail-04-draft-saved'] = await snapshot();

    binding.reportData = <String, dynamic>{'screenshots': shots};
  });
}
