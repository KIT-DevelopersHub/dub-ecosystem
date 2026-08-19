// Smoke tests for the DAV desktop scaffold.
import 'dart:async';

import 'package:dub_desktop/api/gateway_client.dart';
import 'package:dub_desktop/api/models.dart';
import 'package:dub_desktop/api/task_models.dart';
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

  test('Task parses the wire contract incl. nullable fields', () {
    final t = Task.fromJson({
      'id': 'tsk_1',
      'eventId': null,
      'title': '会場を確定する',
      'description': null,
      'status': 'in_progress',
      'priority': 'high',
      'assigneeId': 'usr_kenji',
      'dueAt': '2026-08-25T09:00:00.000Z',
      'origin': 'internal',
      'archivedAt': null,
      'createdAt': '2026-08-10T00:00:00.000Z',
      'updatedAt': '2026-08-15T00:00:00.000Z',
      'version': 3,
    });
    expect(t.status, TaskStatus.inProgress);
    expect(t.priority, TaskPriority.high);
    expect(t.assigneeId, 'usr_kenji');
    expect(t.version, 3);
    expect(t.eventId, isNull);
  });

  test('TaskStatus round-trips its wire value', () {
    for (final s in TaskStatus.values) {
      expect(TaskStatus.fromWire(s.wire), s);
    }
    expect(TaskStatus.inProgress.wire, 'in_progress');
  });

  test('status transition table matches @dub/types (done reopens only)', () {
    expect(kTaskStatusTransitions[TaskStatus.done], [TaskStatus.inProgress]);
    expect(kTaskStatusTransitions[TaskStatus.blocked],
        isNot(contains(TaskStatus.done)));
    expect(kTaskStatusTransitions[TaskStatus.todo],
        contains(TaskStatus.inProgress));
  });

  test('copyWith clearAssignee unassigns without touching version', () {
    final t = Task.fromJson({
      'id': 'tsk_2',
      'title': 't',
      'status': 'todo',
      'priority': 'medium',
      'assigneeId': 'usr_x',
      'origin': 'internal',
      'createdAt': '2026-08-12T00:00:00.000Z',
      'updatedAt': '2026-08-12T00:00:00.000Z',
      'version': 1,
    });
    final cleared = t.copyWith(clearAssignee: true);
    expect(cleared.assigneeId, isNull);
    expect(cleared.version, 1);
    final reassigned = t.copyWith(assigneeId: 'usr_y');
    expect(reassigned.assigneeId, 'usr_y');
  });
}
