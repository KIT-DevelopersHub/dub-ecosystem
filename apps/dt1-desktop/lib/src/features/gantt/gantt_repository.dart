import '../../api/proxy_repository.dart';
import '../../api/wire.dart';

/// One schedule row (gantt-service.yaml `GanttRow`). Keys match the spec.
class GanttRow {
  GanttRow({
    required this.taskId,
    required this.title,
    required this.progressPercent,
    required this.startsAt,
    required this.endsAt,
  });

  final String taskId;
  final String title;
  final int progressPercent;
  final DateTime? startsAt;
  final DateTime? endsAt;

  factory GanttRow.fromJson(Map<String, Object?> j) => GanttRow(
        taskId: asString(j['taskId']),
        title: asString(j['title']),
        progressPercent: asInt(j['progressPercent']),
        startsAt: asDate(j['startsAt']),
        endsAt: asDate(j['endsAt']),
      );
}

/// A resolved gantt chart (`GanttChartDTO`): the rows for one event.
class GanttChart {
  GanttChart({required this.eventId, required this.rows});

  final String eventId;
  final List<GanttRow> rows;

  factory GanttChart.fromJson(Map<String, Object?> j) => GanttChart(
        eventId: asString(j['eventId']),
        rows: (j['rows'] is List)
            ? (j['rows'] as List)
                .whereType<Map>()
                .map((m) => GanttRow.fromJson(m.cast<String, Object?>()))
                .toList()
            : const [],
      );
}

/// Reads an event's schedule through the gateway proxy
/// (`GET /api/v1/gantt?eventId=`). The `eventId` key is exactly the one the
/// PR#231 `?event=` bug got wrong — sourced from [kDesktopWire] and guarded by
/// the desktop-wire reconciliation test.
class GanttRepository {
  GanttRepository(this._proxy);

  final ProxyClient _proxy;

  Future<GanttChart> fetchGantt({required String eventId}) async {
    final op = kDesktopWire['getGantt']!;
    final query = buildQuery(op, {'eventId': eventId});
    final body = await _proxy.getJson('/api/v1/gantt$query');
    if (body is Map) return GanttChart.fromJson(body.cast<String, Object?>());
    return GanttChart(eventId: eventId, rows: const []);
  }
}
