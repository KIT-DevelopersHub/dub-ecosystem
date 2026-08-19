// Smoke tests for the DAV desktop scaffold.
import 'dart:async';

import 'package:dub_desktop/api/gateway_client.dart';
import 'package:dub_desktop/api/models.dart';
import 'package:dub_desktop/main.dart';
import 'package:dub_desktop/state/auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('boots and builds the widget tree (splash while probing)',
      (tester) async {
    // Override the gateway client with a future that never resolves, so the
    // auth bootstrap stays in the `unknown` phase and no real network/timer is
    // created. Deterministic.
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          gatewayClientProvider
              .overrideWith((ref) => Completer<GatewayClient>().future),
        ],
        child: const DubDesktopApp(),
      ),
    );
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
  });

  test('InboxItem parses the wire contract and unread flag', () {
    final item = InboxItem.fromJson({
      'id': 'ntf_1',
      'type': 'deploy',
      'title': 't',
      'body': 'b',
      'readAt': null,
      'createdAt': '2026-08-19T00:00:00.000Z',
    });
    expect(item.isUnread, isTrue);
    expect(item.type, 'deploy');
  });

  test('MeResponse parses user + permissions', () {
    final me = MeResponse.fromJson({
      'user': {'id': 'u', 'displayName': 'D', 'avatarUrl': null},
      'orgId': 'org_devhub',
      'permissions': ['a', 'b'],
      'sessionExpiresAt': 123,
    });
    expect(me.user.displayName, 'D');
    expect(me.permissions.length, 2);
  });

  test('DubApiException decodes the @dub/errors envelope', () {
    final e = DubApiException.fromResponse(
      {
        'error': {'code': 'UNAUTHENTICATED', 'message': 'nope', 'retryable': false}
      },
      statusCode: 401,
    );
    expect(e.code, 'UNAUTHENTICATED');
    expect(e.statusCode, 401);
  });

  test('PaginatedEvents parses summaries + nullable startsAt', () {
    final page = PaginatedEvents.fromJson({
      'items': [
        {'id': 'e1', 'title': 'Conf', 'phase': 'preparing', 'startsAt': null},
        {
          'id': 'e2',
          'title': 'Meetup',
          'phase': 'open',
          'startsAt': '2026-09-01T09:00:00.000Z'
        },
      ],
      'nextCursor': null,
    });
    expect(page.items.length, 2);
    expect(page.items.first.startsAt, isNull);
    expect(page.items[1].phase, 'open');
  });

  test('EventDetail parses DubEvent fields + actions', () {
    final d = EventDetail.fromJson({
      'id': 'e1',
      'title': 'Conf',
      'phase': 'live',
      'version': 3,
      'actions': [
        {'id': 'a1', 'eventId': 'e1', 'kind': 'venue', 'title': '会場'},
      ],
    });
    expect(d.version, 3);
    expect(d.actions.single.title, '会場');
  });

  test('DriveFile detects folders via mimeType', () {
    final folder = DriveFile.fromJson({
      'id': 'f1',
      'name': '資料',
      'mimeType': 'application/vnd.google-apps.folder',
      'modifiedAt': '2026-08-19T00:00:00.000Z',
    });
    final file = DriveFile.fromJson({
      'id': 'f2',
      'name': 'a.pdf',
      'mimeType': 'application/pdf',
      'modifiedAt': '2026-08-19T00:00:00.000Z',
    });
    expect(folder.isFolder, isTrue);
    expect(file.isFolder, isFalse);
  });
}
