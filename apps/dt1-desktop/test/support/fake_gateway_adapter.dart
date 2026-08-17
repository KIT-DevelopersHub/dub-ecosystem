import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';

import 'fake_gateway.dart' show FakeSeed;

/// An in-memory [HttpClientAdapter] that answers gateway requests from seeded
/// demo data via `Future.value` — so the whole app can be driven under the
/// fake-async test clock (a real socket never fires there). Same paths + JSON
/// shapes as the real gateway, so the app exercises its real auth flow,
/// generated client and proxy repositories.
class FakeGatewayAdapter implements HttpClientAdapter {
  @override
  void close({bool force = false}) {}

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    final path = options.uri.path;
    final q = options.uri.queryParameters;

    Object? body;
    var status = 200;

    switch (path) {
      case '/api/v1/auth/password/login':
        body = {
          'token': 'demo_session_token',
          'session': {'userId': 'usr_demo', 'client': 'web', 'sessionExpiresAt': 1893456000000},
        };
      case '/api/v1/auth/logout':
        body = {'ok': true};
      case '/api/v1/me':
        body = FakeSeed.me;
      case '/api/v1/bff/home':
        body = FakeSeed.home;
      case '/api/v1/notifications/inbox':
        final unread = q['unreadOnly'] == 'true';
        body = {
          'items': unread ? FakeSeed.inbox.where((n) => n['readAt'] == null).toList() : FakeSeed.inbox,
          'nextCursor': null,
        };
      case '/api/v1/tasks':
        body = {'items': FakeSeed.tasks, 'nextCursor': null};
      case '/api/v1/events':
        body = {'items': FakeSeed.events, 'nextCursor': null};
      case '/api/v1/gantt':
        body = {'eventId': q['eventId'] ?? 'ev_conf', 'rows': FakeSeed.ganttRows, 'dependencies': []};
      default:
        status = 404;
        body = {'error': {'code': 'NOT_FOUND', 'message': 'no', 'retryable': false}};
    }

    final bytes = utf8.encode(jsonEncode(body));
    return ResponseBody.fromBytes(
      bytes,
      status,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }
}
