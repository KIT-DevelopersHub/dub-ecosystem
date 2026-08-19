import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/gantt_api.dart';
import '../api/gantt_models.dart';
import 'auth.dart';

/// The event whose gantt the desktop shows. The mock gateway answers for any id;
/// this matches the seeded conference event used elsewhere in the slice.
const String kDemoEventId = 'evt_conf';

/// Immutable UI state for the gantt screen.
class GanttUiState {
  const GanttUiState({
    this.loading = true,
    this.chart,
    this.view,
    this.error,
    this.toast,
  });

  final bool loading;
  final GanttChartDTO? chart;
  final GanttViewState? view;

  /// Fatal load error (blocks the chart).
  final Object? error;

  /// Transient message for a failed/rolled-back mutation (shown as a toast).
  final String? toast;

  GanttZoom get zoom => view?.zoom ?? GanttZoom.week;

  GanttUiState copyWith({
    bool? loading,
    GanttChartDTO? chart,
    GanttViewState? view,
    Object? error,
    bool clearError = false,
    String? toast,
    bool clearToast = false,
  }) {
    return GanttUiState(
      loading: loading ?? this.loading,
      chart: chart ?? this.chart,
      view: view ?? this.view,
      error: clearError ? null : (error ?? this.error),
      toast: clearToast ? null : (toast ?? this.toast),
    );
  }
}

/// Loads + mutates the gantt for one event. All mutations are optimistic: the
/// UI updates first, the server call follows, and a failure rolls back and
/// surfaces a toast (memory: optimistic-ui-principle).
class GanttController extends StateNotifier<GanttUiState> {
  GanttController(this._ref, this.eventId) : super(const GanttUiState()) {
    load();
  }

  final Ref _ref;
  final String eventId;

  Future<GanttApi> get _api async =>
      GanttApi(await _ref.read(gatewayClientProvider.future));

  Future<void> load() async {
    state = state.copyWith(loading: true, clearError: true);
    try {
      final api = await _api;
      final chart = await api.chart(eventId);
      // View state is best-effort — a chart with default zoom is still useful.
      GanttViewState view;
      try {
        view = await api.view(eventId);
      } catch (_) {
        view = GanttViewState(
          eventId: eventId,
          zoom: GanttZoom.week,
          collapsedTaskIds: const [],
        );
      }
      state = state.copyWith(loading: false, chart: chart, view: view);
    } catch (e) {
      state = state.copyWith(loading: false, error: e);
    }
  }

  void dismissToast() => state = state.copyWith(clearToast: true);

  /// Optimistically move/resize a leaf bar, then persist via PATCH. Rolls back
  /// on failure. `taskId` must be a scheduled leaf row.
  Future<void> moveBar(
    String taskId, {
    required DateTime newStart,
    required DateTime newEnd,
  }) async {
    final chart = state.chart;
    if (chart == null) return;

    final previous = chart.rows;
    final next = [
      for (final r in previous)
        if (r.taskId == taskId)
          r.copyWith(startsAt: newStart, endsAt: newEnd)
        else
          r,
    ];
    // 1) optimistic apply
    state = state.copyWith(chart: chart.withRows(next), clearToast: true);

    try {
      // 2) persist
      final api = await _api;
      final saved =
          await api.patchRow(taskId, startsAt: newStart, endsAt: newEnd);
      // 3) reconcile with the server's authoritative row
      final reconciled = [
        for (final r in state.chart!.rows)
          if (r.taskId == taskId) saved else r,
      ];
      state = state.copyWith(chart: state.chart!.withRows(reconciled));
    } catch (e) {
      // 4) rollback
      state = state.copyWith(
        chart: chart.withRows(previous),
        toast: '保存に失敗しました。変更を元に戻しました',
      );
    }
  }

  /// Optimistically change zoom, then persist the view state via PUT.
  Future<void> setZoom(GanttZoom zoom) async {
    final view = state.view;
    if (view == null || view.zoom == zoom) return;
    final previous = view;
    state = state.copyWith(view: view.copyWith(zoom: zoom), clearToast: true);
    try {
      final api = await _api;
      final saved = await api.putView(
        eventId,
        zoom: zoom,
        collapsedTaskIds: previous.collapsedTaskIds,
        orderedTaskIds: previous.orderedTaskIds,
      );
      state = state.copyWith(view: saved);
    } catch (_) {
      state = state.copyWith(
        view: previous,
        toast: 'ズーム設定の保存に失敗しました',
      );
    }
  }
}

final ganttControllerProvider =
    StateNotifierProvider<GanttController, GanttUiState>((ref) {
  return GanttController(ref, kDemoEventId);
});
