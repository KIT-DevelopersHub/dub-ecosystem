import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dt1_desktop/src/api/gateway_client.dart';
import 'package:dt1_desktop/src/api/proxy_repository.dart';
import 'package:dt1_desktop/src/api/wire.dart';
import 'package:dt1_desktop/src/auth/auth_controller.dart';
import 'package:dt1_desktop/src/auth/auth_repository.dart';
import 'package:dt1_desktop/src/config/app_config.dart';
import 'package:dt1_desktop/src/features/events/events_repository.dart';
import 'package:dt1_desktop/src/features/gantt/gantt_repository.dart';
import 'package:dt1_desktop/src/features/me/me_repository.dart';
import 'package:dt1_desktop/src/features/notifications/notifications_repository.dart';
import 'package:dt1_desktop/src/features/tasks/tasks_repository.dart';
import 'package:flutter_test/flutter_test.dart';

/// Verifies the P2 proxy apps decode real service payloads AND — critically —
/// that each repository sends the exact query keys the desktop wire descriptor
/// declares (the class of bug PR#231's `?event=` was). A mock gateway records
/// the request URIs so drift is caught here, not in production.
void main() {
  late HttpServer server;
  late String baseUrl;
  final requested = <String>[];

  setUp(() async {
    requested.clear();
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    baseUrl = 'http://127.0.0.1:${server.port}';
    unawaited(_serve(server, requested));
  });

  tearDown(() async => server.close(force: true));

  ProxyClient proxy() => ProxyClient(
        Gateway.create(AppConfig(apiBaseUrl: baseUrl), tokenProvider: () => 't').dio,
      );

  test('gantt repo uses ?eventId= (NOT ?event=) and decodes rows', () async {
    final chart = await GanttRepository(proxy()).fetchGantt(eventId: 'ev_1');
    expect(chart.eventId, 'ev_1');
    expect(chart.rows.single.title, 'Keynote');
    expect(chart.rows.single.progressPercent, 40);
    expect(requested.single, contains('eventId=ev_1'));
    expect(requested.single, isNot(contains('event=ev_1')));
  });

  test('tasks repo scopes by ?assigneeId= and decodes tasks', () async {
    final tasks = await TasksRepository(proxy()).fetchMyTasks(assigneeId: 'usr_9');
    expect(tasks.single.title, 'Prepare venue');
    expect(tasks.single.status, 'in_progress');
    expect(requested.single, contains('assigneeId=usr_9'));
  });

  test('notifications repo reads the inbox with ?unreadOnly=', () async {
    final items = await NotificationsRepository(proxy()).fetchInbox(unreadOnly: true);
    expect(items.single.title, 'You were assigned a task');
    expect(items.single.isUnread, isTrue);
    expect(requested.single, allOf(contains('/notifications/inbox'), contains('unreadOnly=true')));
  });

  test('events repo decodes the paginated events list', () async {
    final events = await EventsRepository(proxy()).fetchEvents();
    expect(events.single.title, 'DevHub Conf');
    expect(events.single.phase, 'published');
  });

  test('403 surfaces a permission-scoped ApiException', () async {
    try {
      await GanttRepository(proxy()).fetchGantt(eventId: 'forbidden');
      fail('expected ApiException');
    } on ApiException catch (e) {
      expect(e.status, 403);
    }
  });

  test('wire buildQuery drops nulls and only emits declared keys', () {
    final op = kDesktopWire['listTasks']!;
    final q = buildQuery(op, {'assigneeId': 'u1', 'eventId': null});
    expect(q, '?assigneeId=u1');
  });

  group('auth flow', () {
    test('login stores the bearer token and composes /me', () async {
      final gateway = Gateway.create(AppConfig(apiBaseUrl: baseUrl), tokenProvider: () => null);
      final auth = AuthController(
        authRepo: AuthRepository(gateway.dio),
        meRepo: MeRepository(gateway.api),
      );
      await auth.login(email: 'user@developershub.jp', password: 'pw');
      expect(auth.status, AuthStatus.signedIn);
      expect(auth.token, 'sess_tok_xyz');
      expect(auth.me?.user.displayName, 'Kotaro Takaoka');
      expect(auth.can('event:read'), isTrue);
    });

    test('invalid credentials keep the user signed out with a message', () async {
      final gateway = Gateway.create(AppConfig(apiBaseUrl: baseUrl), tokenProvider: () => null);
      final auth = AuthController(
        authRepo: AuthRepository(gateway.dio),
        meRepo: MeRepository(gateway.api),
      );
      await auth.login(email: 'nobody@developershub.jp', password: 'wrong');
      expect(auth.status, AuthStatus.signedOut);
      expect(auth.error, isNotNull);
    });
  });
}

Future<void> _serve(HttpServer server, List<String> requested) async {
  await for (final req in server) {
    final path = req.uri.path;
    requested.add(req.uri.toString());
    final res = req.response;
    res.headers.contentType = ContentType.json;

    if (path == '/api/v1/auth/password/login') {
      final body = jsonDecode(await utf8.decoder.bind(req).join()) as Map;
      if (body['password'] == 'pw') {
        res.write(jsonEncode({
          'token': 'sess_tok_xyz',
          'session': {'userId': 'usr_123', 'client': 'web', 'sessionExpiresAt': 1893456000000},
        }));
      } else {
        res.statusCode = 401;
        res.write(jsonEncode({'error': {'code': 'AUTH_INVALID_CREDENTIALS', 'message': 'no', 'retryable': false}}));
      }
    } else if (path == '/api/v1/me') {
      res.write(jsonEncode({
        'user': {'id': 'usr_123', 'displayName': 'Kotaro Takaoka', 'avatarUrl': null},
        'orgId': 'org_devhub',
        'permissions': ['event:read', 'task:read'],
        'sessionExpiresAt': 1893456000000,
      }));
    } else if (path == '/api/v1/gantt' && req.uri.queryParameters['eventId'] == 'forbidden') {
      res.statusCode = 403;
      res.write(jsonEncode({'error': {'code': 'FORBIDDEN', 'message': 'no', 'retryable': false}}));
    } else if (path == '/api/v1/gantt') {
      res.write(jsonEncode({
        'eventId': req.uri.queryParameters['eventId'],
        'rows': [{'taskId': 't1', 'title': 'Keynote', 'progressPercent': 40, 'startsAt': null, 'endsAt': null}],
        'dependencies': [],
      }));
    } else if (path == '/api/v1/tasks') {
      res.write(jsonEncode({
        'items': [{'id': 't1', 'eventId': 'ev_1', 'title': 'Prepare venue', 'status': 'in_progress', 'priority': 'high', 'origin': 'manual', 'version': 1, 'createdAt': '2026-01-01T00:00:00Z', 'updatedAt': '2026-01-01T00:00:00Z'}],
        'nextCursor': null,
      }));
    } else if (path == '/api/v1/notifications/inbox') {
      res.write(jsonEncode({
        'items': [{'id': 'n1', 'type': 'task.assigned', 'title': 'You were assigned a task', 'body': 'Prepare venue', 'readAt': null, 'createdAt': '2026-01-01T00:00:00Z'}],
        'nextCursor': null,
      }));
    } else if (path == '/api/v1/events') {
      res.write(jsonEncode({
        'items': [{'id': 'ev_1', 'orgId': 'org_devhub', 'title': 'DevHub Conf', 'phase': 'published', 'startsAt': '2026-08-05T00:00:00Z', 'endsAt': null}],
        'nextCursor': null,
      }));
    } else {
      res.statusCode = 404;
      res.write('{}');
    }
    await res.close();
  }
}
