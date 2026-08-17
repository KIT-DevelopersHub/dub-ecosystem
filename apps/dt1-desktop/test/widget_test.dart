import 'package:dt1_desktop/src/features/me/home_screen.dart';
import 'package:dt1_desktop/src/features/me/me_repository.dart';
import 'package:dub_api_client/dub_api_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// Home screen renders the identity view once `/me` resolves. Uses a fake
/// repository so the widget layer is verified without any transport.
class _FakeMeRepository implements MeRepository {
  @override
  Future<MeResponse> fetchMe() async => MeResponse((b) => b
    ..user.update((u) => u
      ..id = 'usr_1'
      ..displayName = 'Ada Lovelace')
    ..orgId = 'org_devhub'
    ..permissions.replace(<String>['event:read'])
    ..sessionExpiresAt = 1893456000000);
}

void main() {
  testWidgets('home shows user, org and permissions from /me', (tester) async {
    await tester.pumpWidget(
      MaterialApp(home: HomeScreen(meRepository: _FakeMeRepository())),
    );
    await tester.pumpAndSettle();

    expect(find.text('Ada Lovelace'), findsOneWidget);
    expect(find.text('org: org_devhub'), findsOneWidget);
    expect(find.text('event:read'), findsOneWidget);
  });
}
