import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// Seeded demo data shared by the in-memory adapter (headless tests /
/// screenshots) and the HTTP server (live `-d macos` runs). Same JSON shapes the
/// real gateway/services return.
class FakeSeed {
  static const me = {
    'user': {'id': 'usr_demo', 'displayName': '高岡 己太朗', 'avatarUrl': null},
    'orgId': 'developershub',
    'permissions': ['event:read', 'task:read', 'notif:inbox:self', 'usage:view', 'identity:read', 'drive:read'],
    'sessionExpiresAt': 1893456000000,
  };

  static const home = {
    'upcomingEvents': [
      {'id': 'ev_conf', 'title': '北陸ITカンファレンス', 'phase': 'preparing', 'startsAt': '2026-08-05T09:00:00Z'},
      {'id': 'ev_hack', 'title': 'Hackit 2026', 'phase': 'planning', 'startsAt': '2026-09-12T10:00:00Z'},
    ],
    'unreadCount': 3,
    'partialErrors': <Map<String, Object?>>[],
  };

  static const inbox = [
    {'id': 'n1', 'type': 'task.assigned', 'title': 'タスクが割り当てられました', 'body': '「基調講演の準備」が割り当てられました', 'readAt': null, 'createdAt': '2026-08-01T09:00:00Z'},
    {'id': 'n2', 'type': 'event.published', 'title': 'イベントが公開されました', 'body': '北陸ITカンファレンスが公開されました', 'readAt': null, 'createdAt': '2026-07-30T12:00:00Z'},
    {'id': 'n3', 'type': 'deploy', 'title': '新機能をリリースしました', 'body': 'ガントチャートを刷新しました', 'readAt': '2026-07-29T00:00:00Z', 'createdAt': '2026-07-29T08:00:00Z'},
  ];

  static const tasks = [
    {'id': 't1', 'eventId': 'ev_conf', 'title': '基調講演の準備', 'status': 'in_progress', 'priority': 'high', 'origin': 'manual', 'version': 1, 'dueAt': '2026-08-03T00:00:00Z', 'createdAt': '2026-07-01T00:00:00Z', 'updatedAt': '2026-07-20T00:00:00Z'},
    {'id': 't2', 'eventId': 'ev_conf', 'title': '会場設営の手配', 'status': 'todo', 'priority': 'normal', 'origin': 'manual', 'version': 1, 'dueAt': '2026-08-04T00:00:00Z', 'createdAt': '2026-07-01T00:00:00Z', 'updatedAt': '2026-07-01T00:00:00Z'},
    {'id': 't3', 'eventId': 'ev_hack', 'title': '登壇者への連絡', 'status': 'done', 'priority': 'low', 'origin': 'manual', 'version': 1, 'createdAt': '2026-06-01T00:00:00Z', 'updatedAt': '2026-07-10T00:00:00Z'},
  ];

  static const events = [
    {'id': 'ev_conf', 'orgId': 'developershub', 'title': '北陸ITカンファレンス', 'phase': 'published', 'startsAt': '2026-08-05T09:00:00Z', 'endsAt': '2026-08-05T18:00:00Z'},
    {'id': 'ev_hack', 'orgId': 'developershub', 'title': 'Hackit 2026', 'phase': 'published', 'startsAt': '2026-09-12T10:00:00Z', 'endsAt': '2026-09-13T18:00:00Z'},
  ];

  static const ganttRows = [
    {'taskId': 't1', 'title': '基調講演の準備', 'progressPercent': 60, 'startsAt': '2026-07-20T00:00:00Z', 'endsAt': '2026-08-03T00:00:00Z'},
    {'taskId': 't2', 'title': '会場設営の手配', 'progressPercent': 20, 'startsAt': '2026-07-25T00:00:00Z', 'endsAt': '2026-08-04T00:00:00Z'},
    {'taskId': 't3', 'title': '登壇者への連絡', 'progressPercent': 100, 'startsAt': '2026-06-01T00:00:00Z', 'endsAt': '2026-07-10T00:00:00Z'},
  ];
}

/// An in-process fake api-gateway (real HTTP server) seeded with [FakeSeed], for
/// driving the app over a real socket in a live `flutter run/test -d macos` run.
/// Headless tests use FakeGatewayAdapter instead (the fake-async clock cannot
/// pump real socket IO).
class FakeGateway {
  FakeGateway._(this._server, this.baseUrl);

  final HttpServer _server;
  final String baseUrl;

  static Future<FakeGateway> start() async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final gw = FakeGateway._(server, 'http://127.0.0.1:${server.port}');
    unawaited(gw._serve());
    return gw;
  }

  Future<void> stop() => _server.close(force: true);

  Future<void> _serve() async {
    await for (final req in _server) {
      final res = req.response..headers.contentType = ContentType.json;
      final path = req.uri.path;
      final q = req.uri.queryParameters;

      if (path == '/api/v1/auth/password/login') {
        await utf8.decoder.bind(req).join();
        res.write(jsonEncode({
          'token': 'demo_session_token',
          'session': {'userId': 'usr_demo', 'client': 'web', 'sessionExpiresAt': 1893456000000},
        }));
      } else if (path == '/api/v1/me') {
        res.write(jsonEncode(FakeSeed.me));
      } else if (path == '/api/v1/bff/home') {
        res.write(jsonEncode(FakeSeed.home));
      } else if (path == '/api/v1/notifications/inbox') {
        final unread = q['unreadOnly'] == 'true';
        res.write(jsonEncode({
          'items': unread ? FakeSeed.inbox.where((n) => n['readAt'] == null).toList() : FakeSeed.inbox,
          'nextCursor': null,
        }));
      } else if (path == '/api/v1/tasks') {
        res.write(jsonEncode({'items': FakeSeed.tasks, 'nextCursor': null}));
      } else if (path == '/api/v1/events') {
        res.write(jsonEncode({'items': FakeSeed.events, 'nextCursor': null}));
      } else if (path == '/api/v1/gantt') {
        res.write(jsonEncode({'eventId': q['eventId'] ?? 'ev_conf', 'rows': FakeSeed.ganttRows, 'dependencies': []}));
      } else {
        res.statusCode = 404;
        res.write('{}');
      }
      await res.close();
    }
  }
}
