/// Dart mirrors of the gantt-service wire contract
/// (`docs/openapi/gantt-service.yaml`, external segment `/api/v1/gantt`).
///
/// Written strictly to the spec. NOTE: `GanttRow` carries no parent/WBS field —
/// hierarchy is a task-service concern not exposed here — so the desktop gantt
/// renders the flat scheduled rows plus FS dependency lines. Every row is a
/// "leaf" for editing purposes, which matches the web learning (#329) that only
/// leaf bars persist a move; there is no parent bar to resize in this contract.
library;

/// gantt-service `GanttZoom`.
enum GanttZoom {
  day,
  week,
  month;

  static GanttZoom fromWire(String? v) {
    switch (v) {
      case 'week':
        return GanttZoom.week;
      case 'month':
        return GanttZoom.month;
      case 'day':
      default:
        return GanttZoom.day;
    }
  }

  String get wire => name;
}

/// gantt-service `GanttRow`. `startsAt`/`endsAt` are ISO8601 date-time or null;
/// parsed to [DateTime] (UTC) for layout, with the raw strings retained so a
/// round-trip PATCH echoes exactly what the server sent for unedited bounds.
class GanttRow {
  const GanttRow({
    required this.taskId,
    required this.title,
    required this.startsAt,
    required this.endsAt,
    required this.progressPercent,
    this.assigneeId,
  });

  final String taskId;
  final String title;

  /// null when the task has no scheduled start (unplaced — no bar drawn).
  final DateTime? startsAt;
  final DateTime? endsAt;

  final int progressPercent;
  final String? assigneeId;

  /// A bar is drawable only when both bounds are present and ordered.
  bool get isScheduled =>
      startsAt != null && endsAt != null && !endsAt!.isBefore(startsAt!);

  factory GanttRow.fromJson(Map<String, dynamic> json) => GanttRow(
        taskId: json['taskId'] as String,
        title: json['title'] as String,
        startsAt: _parseDate(json['startsAt']),
        endsAt: _parseDate(json['endsAt']),
        progressPercent: (json['progressPercent'] as num?)?.toInt() ?? 0,
        assigneeId: json['assigneeId'] as String?,
      );

  GanttRow copyWith({DateTime? startsAt, DateTime? endsAt}) => GanttRow(
        taskId: taskId,
        title: title,
        startsAt: startsAt ?? this.startsAt,
        endsAt: endsAt ?? this.endsAt,
        progressPercent: progressPercent,
        assigneeId: assigneeId,
      );

  static DateTime? _parseDate(Object? v) {
    if (v is! String || v.isEmpty) return null;
    return DateTime.tryParse(v)?.toUtc();
  }
}

/// gantt-service `GanttDependencyLine`. Only FS (finish-to-start) exists today.
class GanttDependencyLine {
  const GanttDependencyLine({
    required this.id,
    required this.fromTaskId,
    required this.toTaskId,
    required this.type,
    required this.lagDays,
  });

  final String id;
  final String fromTaskId;
  final String toTaskId;
  final String type;
  final int lagDays;

  factory GanttDependencyLine.fromJson(Map<String, dynamic> json) =>
      GanttDependencyLine(
        id: json['id'] as String,
        fromTaskId: json['fromTaskId'] as String,
        toTaskId: json['toTaskId'] as String,
        type: json['type'] as String? ?? 'FS',
        lagDays: (json['lagDays'] as num?)?.toInt() ?? 0,
      );
}

/// gantt-service `GanttChartDTO` — the whole chart read model for one event.
class GanttChartDTO {
  const GanttChartDTO({
    required this.eventId,
    required this.rows,
    required this.dependencies,
  });

  final String eventId;
  final List<GanttRow> rows;
  final List<GanttDependencyLine> dependencies;

  factory GanttChartDTO.fromJson(Map<String, dynamic> json) => GanttChartDTO(
        eventId: json['eventId'] as String,
        rows: (json['rows'] as List<dynamic>? ?? const [])
            .map((e) => GanttRow.fromJson(e as Map<String, dynamic>))
            .toList(),
        dependencies: (json['dependencies'] as List<dynamic>? ?? const [])
            .map((e) =>
                GanttDependencyLine.fromJson(e as Map<String, dynamic>))
            .toList(),
      );

  GanttChartDTO withRows(List<GanttRow> next) => GanttChartDTO(
        eventId: eventId,
        rows: next,
        dependencies: dependencies,
      );
}

/// gantt-service `GanttViewState` — per-user saved view (zoom, collapsed, order).
class GanttViewState {
  const GanttViewState({
    required this.eventId,
    required this.zoom,
    required this.collapsedTaskIds,
    this.orderedTaskIds,
  });

  final String eventId;
  final GanttZoom zoom;
  final List<String> collapsedTaskIds;

  /// Additive/optional per-user manual row order; null = server order.
  final List<String>? orderedTaskIds;

  factory GanttViewState.fromJson(Map<String, dynamic> json) => GanttViewState(
        eventId: json['eventId'] as String,
        zoom: GanttZoom.fromWire(json['zoom'] as String?),
        collapsedTaskIds: (json['collapsedTaskIds'] as List<dynamic>? ?? const [])
            .map((e) => e as String)
            .toList(),
        orderedTaskIds: (json['orderedTaskIds'] as List<dynamic>?)
            ?.map((e) => e as String)
            .toList(),
      );

  GanttViewState copyWith({GanttZoom? zoom}) => GanttViewState(
        eventId: eventId,
        zoom: zoom ?? this.zoom,
        collapsedTaskIds: collapsedTaskIds,
        orderedTaskIds: orderedTaskIds,
      );
}
