import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/gateway_client.dart';
import '../api/models.dart';
import '../api/task_models.dart';
import 'auth.dart';

/// Roster of users, for resolving assignee ids to names in the picker. Requires
/// `identity:read`; if the caller lacks it (403) or the call fails, we degrade
/// gracefully to an empty roster (the UI then shows the raw id).
final rosterProvider = FutureProvider<List<RosterUser>>((ref) async {
  final client = await ref.watch(gatewayClientProvider.future);
  try {
    return await client.listRosterUsers();
  } on DubApiException {
    return const <RosterUser>[];
  }
});

/// The task list with **optimistic mutations**. State is the current list;
/// [changeStatus]/[assign] apply the change locally first, then persist. On
/// failure they roll the item back and return an error message for the caller
/// to surface as a toast (per the optimistic-UI principle).
class TasksController extends StateNotifier<AsyncValue<List<Task>>> {
  TasksController(this._ref) : super(const AsyncValue.loading()) {
    load();
  }

  final Ref _ref;

  Future<GatewayClient> get _client =>
      _ref.read(gatewayClientProvider.future);

  Future<void> load() async {
    state = const AsyncValue.loading();
    try {
      final page = await (await _client).listTasks(limit: 100);
      state = AsyncValue.data(page.items);
    } on DubApiException catch (e, st) {
      state = AsyncValue.error(e, st);
    } catch (e, st) {
      state = AsyncValue.error(e, st);
    }
  }

  List<Task> get _current => state.valueOrNull ?? const [];

  void _replace(Task next) {
    state = AsyncValue.data([
      for (final t in _current)
        if (t.id == next.id) next else t,
    ]);
  }

  Task? _byId(String id) {
    for (final t in _current) {
      if (t.id == id) return t;
    }
    return null;
  }

  /// Optimistically move a task to [next], then persist. Returns null on
  /// success or an error message (already rolled back) on failure.
  Future<String?> changeStatus(String id, TaskStatus next) async {
    final original = _byId(id);
    if (original == null) return null;
    if (original.status == next) return null;

    // 1) optimistic: reflect immediately.
    _replace(original.copyWith(status: next));
    try {
      // 2) persist with the optimistic-lock version.
      final saved = await (await _client)
          .updateTask(id, version: original.version, status: next);
      // 3) reconcile with the server's authoritative copy (new version).
      _replace(saved);
      return null;
    } on DubApiException catch (e) {
      _replace(original); // rollback
      return _friendly(e);
    } catch (e) {
      _replace(original);
      return 'ネットワークエラー: $e';
    }
  }

  /// Optimistically (re)assign a task. Pass null to unassign.
  Future<String?> assign(String id, String? assigneeId) async {
    final original = _byId(id);
    if (original == null) return null;
    if (original.assigneeId == assigneeId) return null;

    final clear = assigneeId == null;
    _replace(original.copyWith(
      assigneeId: assigneeId,
      clearAssignee: clear,
    ));
    try {
      final saved = await (await _client).updateTask(
        id,
        version: original.version,
        assigneeId: assigneeId,
        clearAssignee: clear,
      );
      _replace(saved);
      return null;
    } on DubApiException catch (e) {
      _replace(original);
      return _friendly(e);
    } catch (e) {
      _replace(original);
      return 'ネットワークエラー: $e';
    }
  }

  String _friendly(DubApiException e) {
    // A stale-version conflict is the one the user can recover from by
    // refreshing; call it out specifically.
    if (e.statusCode == 409 || e.code.contains('CONFLICT')) {
      return '他の変更と競合しました。再読み込みしてやり直してください。';
    }
    return e.message;
  }
}

final tasksControllerProvider =
    StateNotifierProvider<TasksController, AsyncValue<List<Task>>>((ref) {
  return TasksController(ref);
});
