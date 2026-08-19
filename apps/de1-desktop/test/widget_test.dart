// Smoke tests for the DAV desktop scaffold.
import 'dart:async';

import 'package:dub_desktop/api/gateway_client.dart';
import 'package:dub_desktop/api/models.dart';
import 'package:dub_desktop/features/chat/chat_models.dart';
import 'package:dub_desktop/features/notifications/notifications_models.dart';
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

  test('ChannelList + MessagePage parse the chat wire contract', () {
    final channels = ChannelList.fromJson({
      'items': [
        {'id': 'chn_1', 'name': 'general', 'createdAt': '2026-08-19T00:00:00.000Z'}
      ]
    });
    expect(channels.items.single.name, 'general');

    final page = MessagePage.fromJson({
      'items': [
        {
          'id': 'msg_1',
          'channelId': 'chn_1',
          'authorId': 'usr_1',
          'body': 'hi',
          'createdAt': '2026-08-19T00:00:00.000Z'
        }
      ],
      'nextCursor': null,
    });
    expect(page.items.single.body, 'hi');
    expect(page.nextCursor, isNull);
  });

  test('ChatRealtimeEvent message.created -> timeline message', () {
    final e = ChatRealtimeEvent.fromJson({
      'kind': 'message.created',
      'channelId': 'chn_1',
      'messageId': 'msg_9',
      'authorId': 'usr_2',
      'body': 'live',
      'at': '2026-08-19T01:00:00.000Z',
    });
    expect(e.isTimelineMessage, isTrue);
    expect(e.toMessage().body, 'live');
    expect(e.toMessage().id, 'msg_9');
  });

  test('WsTicket.connectUri appends the ticket query param', () {
    final t = WsTicket.fromJson({
      'ticket': 'abc',
      'doUrl': 'wss://chat-rt.example/ws/chn_1',
      'expiresAt': '2026-08-19T01:00:00.000Z',
    });
    final uri = t.connectUri();
    expect(uri.scheme, 'wss');
    expect(uri.path, '/ws/chn_1');
    expect(uri.queryParameters['ticket'], 'abc');
  });
}
