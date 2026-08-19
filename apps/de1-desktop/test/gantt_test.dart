// Tests for the gantt feature: wire-contract parsing and a deterministic
// build smoke test (loading state while the gateway client never resolves).
import 'dart:async';

import 'package:dub_desktop/api/gantt_models.dart';
import 'package:dub_desktop/api/gateway_client.dart';
import 'package:dub_desktop/state/auth.dart';
import 'package:dub_desktop/ui/gantt_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('GanttChartDTO parses rows + FS dependencies from the wire contract', () {
    final chart = GanttChartDTO.fromJson({
      'eventId': 'evt_conf',
      'rows': [
        {
          'taskId': 'tsk_1',
          'title': '企画',
          'startsAt': '2026-08-01T00:00:00.000Z',
          'endsAt': '2026-08-05T00:00:00.000Z',
          'progressPercent': 40,
          'assigneeId': 'usr_demo',
        },
        {
          'taskId': 'tsk_2',
          'title': '未スケジュール',
          'startsAt': null,
          'endsAt': null,
          'progressPercent': 0,
        },
      ],
      'dependencies': [
        {
          'id': 'dep_1',
          'fromTaskId': 'tsk_1',
          'toTaskId': 'tsk_2',
          'type': 'FS',
          'lagDays': 0,
        },
      ],
    });

    expect(chart.eventId, 'evt_conf');
    expect(chart.rows.length, 2);
    expect(chart.rows.first.isScheduled, isTrue);
    expect(chart.rows.first.progressPercent, 40);
    // A row missing both bounds draws no bar.
    expect(chart.rows[1].isScheduled, isFalse);
    expect(chart.dependencies.single.type, 'FS');
  });

  test('GanttRow.copyWith shifts the window (used by optimistic move)', () {
    final row = GanttRow.fromJson({
      'taskId': 'tsk_1',
      'title': 't',
      'startsAt': '2026-08-01T00:00:00.000Z',
      'endsAt': '2026-08-03T00:00:00.000Z',
      'progressPercent': 0,
    });
    final moved = row.copyWith(
      startsAt: row.startsAt!.add(const Duration(days: 2)),
      endsAt: row.endsAt!.add(const Duration(days: 2)),
    );
    expect(moved.startsAt, DateTime.utc(2026, 8, 3));
    expect(moved.endsAt, DateTime.utc(2026, 8, 5));
    // Original is untouched (rollback safety).
    expect(row.startsAt, DateTime.utc(2026, 8, 1));
  });

  test('GanttViewState + GanttZoom round-trip the wire enum', () {
    final view = GanttViewState.fromJson({
      'eventId': 'evt_conf',
      'zoom': 'month',
      'collapsedTaskIds': ['tsk_9'],
      'orderedTaskIds': ['tsk_1', 'tsk_9'],
    });
    expect(view.zoom, GanttZoom.month);
    expect(view.zoom.wire, 'month');
    expect(view.collapsedTaskIds, ['tsk_9']);
    expect(view.orderedTaskIds, ['tsk_1', 'tsk_9']);
    // Unknown/absent zoom falls back to day.
    expect(GanttZoom.fromWire(null), GanttZoom.day);
  });

  testWidgets('GanttView builds and shows a loader while the client resolves',
      (tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          // Never-resolving client keeps the controller in its loading phase —
          // deterministic, no real network/timer.
          gatewayClientProvider
              .overrideWith((ref) => Completer<GatewayClient>().future),
        ],
        child: const MaterialApp(
          home: Scaffold(body: GanttView()),
        ),
      ),
    );
    await tester.pump();
    expect(find.text('ガント'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
  });
}
