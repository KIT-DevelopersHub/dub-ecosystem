import '../../api/proxy_repository.dart';
import '../../api/wire.dart';

/// One task (task-service.yaml `Task`). Only the fields the desktop renders are
/// lifted; keys match the spec.
class TaskItem {
  TaskItem({
    required this.id,
    required this.eventId,
    required this.title,
    required this.status,
    required this.priority,
    required this.dueAt,
  });

  final String id;
  final String eventId;
  final String title;
  final String status; // todo | in_progress | blocked | done | ...
  final String priority; // low | normal | high | urgent
  final DateTime? dueAt;

  bool get isDone => status == 'done';

  factory TaskItem.fromJson(Map<String, Object?> j) => TaskItem(
        id: asString(j['id']),
        eventId: asString(j['eventId']),
        title: asString(j['title']),
        status: asString(j['status'], 'todo'),
        priority: asString(j['priority'], 'normal'),
        dueAt: asDate(j['dueAt']),
      );
}

/// Reads the signed-in user's tasks through the gateway proxy
/// (`GET /api/v1/tasks?assigneeId=<me>`). Query keys come from [kDesktopWire]
/// (`eventId`, `assigneeId`) — the exact keys the gantt `?event=` bug got wrong.
class TasksRepository {
  TasksRepository(this._proxy);

  final ProxyClient _proxy;

  /// Tasks assigned to [assigneeId] (the current user id from `/me`), optionally
  /// scoped to one event.
  Future<List<TaskItem>> fetchMyTasks({required String assigneeId, String? eventId}) async {
    final op = kDesktopWire['listTasks']!;
    final query = buildQuery(op, {'assigneeId': assigneeId, 'eventId': eventId});
    final body = await _proxy.getJson('/api/v1/tasks$query');
    return asItems(body).map(TaskItem.fromJson).toList();
  }
}
