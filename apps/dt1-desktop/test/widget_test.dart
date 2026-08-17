import 'package:dt1_desktop/src/features/me/me_repository.dart';
import 'package:dt1_desktop/src/features/me/profile_screen.dart';
import 'package:dt1_desktop/src/theme/app_theme.dart';
import 'package:dub_api_client/dub_api_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// Profile screen renders the identity view once `/me` resolves. Uses a fake
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
  testWidgets('profile shows user, org and permissions from /me', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        home: Scaffold(body: ProfileScreen(meRepository: _FakeMeRepository())),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Ada Lovelace'), findsOneWidget);
    expect(find.text('org: org_devhub'), findsOneWidget);
    expect(find.text('event:read'), findsOneWidget);
  });
}
