/// Dart mirrors of the task-service wire contract
/// (`docs/openapi/task-service.yaml`, typed in `@dub/types` `task.ts`).
///
/// Hand-written to match the spec exactly, following the same convention as
/// `models.dart` (the architecture doc's long-term plan is OpenAPI->Dart
/// codegen; until then these are minimal, reviewed mirrors).
library;

/// task-service TaskStatus. `done`/`cancelled` are the closed states.
enum TaskStatus {
  todo,
  inProgress,
  blocked,
  done,
  cancelled;

  /// Wire value (snake_case) as serialised by the service.
  String get wire => switch (this) {
        TaskStatus.todo => 'todo',
        TaskStatus.inProgress => 'in_progress',
        TaskStatus.blocked => 'blocked',
        TaskStatus.done => 'done',
        TaskStatus.cancelled => 'cancelled',
      };

  /// Short Japanese label for the UI.
  String get label => switch (this) {
        TaskStatus.todo => '未着手',
        TaskStatus.inProgress => '進行中',
        TaskStatus.blocked => 'ブロック',
        TaskStatus.done => '完了',
        TaskStatus.cancelled => '中止',
      };

  static TaskStatus fromWire(String v) => switch (v) {
        'todo' => TaskStatus.todo,
        'in_progress' => TaskStatus.inProgress,
        'blocked' => TaskStatus.blocked,
        'done' => TaskStatus.done,
        'cancelled' => TaskStatus.cancelled,
        _ => TaskStatus.todo,
      };
}

/// Allowed status transitions — the single source of truth mirrored from
/// `@dub/types` `TASK_STATUS_TRANSITIONS` (server validation + FE4 UI). Used to
/// only offer valid next statuses in the UI, matching what the service accepts.
const Map<TaskStatus, List<TaskStatus>> kTaskStatusTransitions = {
  TaskStatus.todo: [
    TaskStatus.inProgress,
    TaskStatus.blocked,
    TaskStatus.done,
    TaskStatus.cancelled,
  ],
  TaskStatus.inProgress: [
    TaskStatus.todo,
    TaskStatus.blocked,
    TaskStatus.done,
    TaskStatus.cancelled,
  ],
  TaskStatus.blocked: [
    TaskStatus.todo,
    TaskStatus.inProgress,
    TaskStatus.cancelled,
  ],
  TaskStatus.done: [TaskStatus.inProgress],
  TaskStatus.cancelled: [TaskStatus.todo],
};

/// task-service TaskPriority.
enum TaskPriority {
  low,
  medium,
  high,
  urgent;

  String get wire => name;

  String get label => switch (this) {
        TaskPriority.low => '低',
        TaskPriority.medium => '中',
        TaskPriority.high => '高',
        TaskPriority.urgent => '緊急',
      };

  static TaskPriority fromWire(String v) => switch (v) {
        'low' => TaskPriority.low,
        'medium' => TaskPriority.medium,
        'high' => TaskPriority.high,
        'urgent' => TaskPriority.urgent,
        _ => TaskPriority.medium,
      };
}

/// task-service Task. Optimistic-locked (`version` bumps on every write).
class Task {
  const Task({
    required this.id,
    required this.title,
    required this.status,
    required this.priority,
    required this.origin,
    required this.version,
    required this.createdAt,
    required this.updatedAt,
    this.eventId,
    this.description,
    this.assigneeId,
    this.dueAt,
    this.archivedAt,
  });

  final String id;

  /// Optional event linkage — null/absent means a standalone task.
  final String? eventId;
  final String title;
  final String? description;
  final TaskStatus status;
  final TaskPriority priority;
  final String? assigneeId;

  /// ISO8601 UTC or null.
  final String? dueAt;

  /// 'internal' | 'github' (kept as a string — not surfaced in the UI yet).
  final String origin;
  final String? archivedAt;

  /// ISO8601 UTC
  final String createdAt;

  /// ISO8601 UTC
  final String updatedAt;

  /// Optimistic-lock token; must be echoed on the next update.
  final int version;

  bool get isArchived => archivedAt != null;

  factory Task.fromJson(Map<String, dynamic> json) => Task(
        id: json['id'] as String,
        eventId: json['eventId'] as String?,
        title: json['title'] as String,
        description: json['description'] as String?,
        status: TaskStatus.fromWire(json['status'] as String),
        priority: TaskPriority.fromWire(json['priority'] as String),
        assigneeId: json['assigneeId'] as String?,
        dueAt: json['dueAt'] as String?,
        origin: (json['origin'] as String?) ?? 'internal',
        archivedAt: json['archivedAt'] as String?,
        createdAt: json['createdAt'] as String,
        updatedAt: json['updatedAt'] as String,
        version: (json['version'] as num).toInt(),
      );

  /// Local, non-persisted copy used for optimistic updates before the server
  /// confirms. `clearAssignee` distinguishes "unassign" from "leave unchanged".
  Task copyWith({
    TaskStatus? status,
    TaskPriority? priority,
    String? assigneeId,
    bool clearAssignee = false,
    int? version,
  }) =>
      Task(
        id: id,
        eventId: eventId,
        title: title,
        description: description,
        status: status ?? this.status,
        priority: priority ?? this.priority,
        assigneeId: clearAssignee ? null : (assigneeId ?? this.assigneeId),
        dueAt: dueAt,
        origin: origin,
        archivedAt: archivedAt,
        createdAt: createdAt,
        updatedAt: updatedAt,
        version: version ?? this.version,
      );
}

/// task-service PaginatedTasks.
class PaginatedTasks {
  const PaginatedTasks({required this.items, required this.nextCursor});

  final List<Task> items;

  /// null = end of results.
  final String? nextCursor;

  factory PaginatedTasks.fromJson(Map<String, dynamic> json) => PaginatedTasks(
        items: (json['items'] as List<dynamic>? ?? const [])
            .map((e) => Task.fromJson(e as Map<String, dynamic>))
            .toList(),
        nextCursor: json['nextCursor'] as String?,
      );
}

/// A roster user, from identity-roster `/identity/users` — the source for the
/// assignee picker. Only the fields the picker needs are mirrored.
class RosterUser {
  const RosterUser({
    required this.id,
    required this.displayName,
    this.email,
    this.avatarUrl,
  });

  final String id;
  final String displayName;
  final String? email;
  final String? avatarUrl;

  factory RosterUser.fromJson(Map<String, dynamic> json) => RosterUser(
        id: json['id'] as String,
        displayName: json['displayName'] as String,
        email: json['email'] as String?,
        avatarUrl: json['avatarUrl'] as String?,
      );
}
