import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/gantt_models.dart';
import '../api/models.dart';
import '../state/gantt.dart';

// Layout constants shared by the panes and the dependency painter.
const double _leftPaneWidth = 240;
const double _rowHeight = 44;
const double _axisHeight = 30;

double _pxPerDay(GanttZoom z) {
  switch (z) {
    case GanttZoom.day:
      return 40;
    case GanttZoom.week:
      return 16;
    case GanttZoom.month:
      return 6;
  }
}

/// Date-only (UTC midnight) so day indexing ignores time-of-day.
DateTime _dateOnly(DateTime d) => DateTime.utc(d.year, d.month, d.day);

/// Gantt feature screen: left task pane + scrollable timeline with bars and
/// FS dependency lines. Leaf bars can be dragged (move) or resized from the
/// right edge; both persist optimistically.
class GanttView extends ConsumerWidget {
  const GanttView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final state = ref.watch(ganttControllerProvider);
    final theme = Theme.of(context);

    // Surface rolled-back mutations as a toast.
    ref.listen<GanttUiState>(ganttControllerProvider, (prev, next) {
      final msg = next.toast;
      if (msg != null && msg != prev?.toast) {
        ScaffoldMessenger.of(context)
          ..hideCurrentSnackBar()
          ..showSnackBar(SnackBar(content: Text(msg)));
        ref.read(ganttControllerProvider.notifier).dismissToast();
      }
    });

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 20, 24, 8),
          child: Row(
            children: [
              Text('ガント', style: theme.textTheme.headlineSmall),
              const SizedBox(width: 16),
              if (state.chart != null)
                _ZoomSelector(
                  zoom: state.zoom,
                  onChanged: (z) =>
                      ref.read(ganttControllerProvider.notifier).setZoom(z),
                ),
              const Spacer(),
              IconButton(
                tooltip: '再読み込み',
                icon: const Icon(Icons.refresh),
                onPressed: () =>
                    ref.read(ganttControllerProvider.notifier).load(),
              ),
            ],
          ),
        ),
        Expanded(child: _body(context, ref, state)),
      ],
    );
  }

  Widget _body(BuildContext context, WidgetRef ref, GanttUiState state) {
    if (state.loading && state.chart == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (state.error != null && state.chart == null) {
      final e = state.error!;
      final message = e is DubApiException ? e.message : '$e';
      return _ErrorState(
        message: message,
        onRetry: () => ref.read(ganttControllerProvider.notifier).load(),
      );
    }
    final chart = state.chart!;
    final scheduled = chart.rows.where((r) => r.isScheduled).toList();
    if (scheduled.isEmpty) {
      return const _EmptyState();
    }
    return _GanttChart(chart: chart, zoom: state.zoom);
  }
}

class _ZoomSelector extends StatelessWidget {
  const _ZoomSelector({required this.zoom, required this.onChanged});
  final GanttZoom zoom;
  final ValueChanged<GanttZoom> onChanged;

  @override
  Widget build(BuildContext context) {
    return SegmentedButton<GanttZoom>(
      showSelectedIcon: false,
      segments: const [
        ButtonSegment(value: GanttZoom.day, label: Text('日')),
        ButtonSegment(value: GanttZoom.week, label: Text('週')),
        ButtonSegment(value: GanttZoom.month, label: Text('月')),
      ],
      selected: {zoom},
      onSelectionChanged: (s) => onChanged(s.first),
    );
  }
}

/// The aligned two-pane chart. Vertically the whole thing scrolls as one, so the
/// left labels stay in lockstep with their bars.
class _GanttChart extends ConsumerStatefulWidget {
  const _GanttChart({required this.chart, required this.zoom});
  final GanttChartDTO chart;
  final GanttZoom zoom;

  @override
  ConsumerState<_GanttChart> createState() => _GanttChartState();
}

class _GanttChartState extends ConsumerState<_GanttChart> {
  /// Transient per-drag pixel offsets (not yet persisted).
  final Map<String, double> _dragDx = {};
  final Map<String, double> _resizeDx = {};

  late DateTime _rangeStart;
  late int _totalDays;

  @override
  Widget build(BuildContext context) {
    final rows = widget.chart.rows;
    final scheduled = rows.where((r) => r.isScheduled).toList();
    final pxPerDay = _pxPerDay(widget.zoom);

    // Compute the visible date window from the scheduled bars (+ padding).
    var minStart = _dateOnly(scheduled.first.startsAt!);
    var maxEnd = _dateOnly(scheduled.first.endsAt!);
    for (final r in scheduled) {
      final s = _dateOnly(r.startsAt!);
      final e = _dateOnly(r.endsAt!);
      if (s.isBefore(minStart)) minStart = s;
      if (e.isAfter(maxEnd)) maxEnd = e;
    }
    _rangeStart = minStart.subtract(const Duration(days: 2));
    final rangeEnd = maxEnd.add(const Duration(days: 5));
    _totalDays = rangeEnd.difference(_rangeStart).inDays + 1;

    final timelineWidth = _totalDays * pxPerDay;
    final contentHeight = rows.length * _rowHeight;

    return SingleChildScrollView(
      scrollDirection: Axis.vertical,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _LeftPane(rows: rows),
          Expanded(
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: SizedBox(
                width: timelineWidth,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _Axis(
                      rangeStart: _rangeStart,
                      totalDays: _totalDays,
                      pxPerDay: pxPerDay,
                      zoom: widget.zoom,
                    ),
                    SizedBox(
                      height: contentHeight,
                      width: timelineWidth,
                      child: Stack(
                        children: [
                          // Grid + dependency connectors behind the bars.
                          Positioned.fill(
                            child: CustomPaint(
                              painter: _TimelinePainter(
                                rows: rows,
                                dependencies: widget.chart.dependencies,
                                rangeStart: _rangeStart,
                                totalDays: _totalDays,
                                pxPerDay: pxPerDay,
                                gridColor: Theme.of(context)
                                    .colorScheme
                                    .outlineVariant,
                                depColor:
                                    Theme.of(context).colorScheme.outline,
                              ),
                            ),
                          ),
                          for (var i = 0; i < rows.length; i++)
                            if (rows[i].isScheduled)
                              _bar(rows[i], i, pxPerDay),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  double _xForDate(DateTime d, double pxPerDay) =>
      _dateOnly(d).difference(_rangeStart).inDays * pxPerDay;

  Widget _bar(GanttRow row, int index, double pxPerDay) {
    final baseLeft = _xForDate(row.startsAt!, pxPerDay);
    final startIdx = _dateOnly(row.startsAt!).difference(_rangeStart).inDays;
    final endIdx = _dateOnly(row.endsAt!).difference(_rangeStart).inDays;
    final baseWidth = (endIdx - startIdx + 1) * pxPerDay;

    final dragDx = _dragDx[row.taskId] ?? 0;
    final resizeDx = _resizeDx[row.taskId] ?? 0;
    final left = baseLeft + dragDx;
    final width = (baseWidth + resizeDx).clamp(pxPerDay, double.infinity);
    final top = index * _rowHeight + 8;

    final theme = Theme.of(context);
    final barColor = theme.colorScheme.primary;

    return Positioned(
      left: left,
      top: top,
      width: width,
      height: _rowHeight - 16,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        // Whole-bar horizontal move.
        onHorizontalDragUpdate: (d) =>
            setState(() => _dragDx[row.taskId] = dragDx + d.delta.dx),
        onHorizontalDragEnd: (_) => _commitMove(row, pxPerDay),
        child: Tooltip(
          message: _barTooltip(row),
          child: Stack(
            children: [
              Positioned.fill(
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: barColor.withValues(alpha: 0.25),
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: barColor),
                  ),
                  child: FractionallySizedBox(
                    alignment: Alignment.centerLeft,
                    widthFactor: (row.progressPercent / 100).clamp(0.0, 1.0),
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        color: barColor,
                        borderRadius: BorderRadius.circular(6),
                      ),
                    ),
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 6),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    '${row.progressPercent}%',
                    style: theme.textTheme.labelSmall
                        ?.copyWith(color: theme.colorScheme.onPrimary),
                  ),
                ),
              ),
              // Right-edge resize handle (leaf-only edit).
              Positioned(
                right: 0,
                top: 0,
                bottom: 0,
                width: 10,
                child: MouseRegion(
                  cursor: SystemMouseCursors.resizeLeftRight,
                  child: GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onHorizontalDragUpdate: (d) => setState(
                        () => _resizeDx[row.taskId] = resizeDx + d.delta.dx),
                    onHorizontalDragEnd: (_) => _commitResize(row, pxPerDay),
                    child: const SizedBox.shrink(),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _commitMove(GanttRow row, double pxPerDay) {
    final dx = _dragDx.remove(row.taskId) ?? 0;
    setState(() {});
    final shiftDays = (dx / pxPerDay).round();
    if (shiftDays == 0) return;
    final delta = Duration(days: shiftDays);
    ref.read(ganttControllerProvider.notifier).moveBar(
          row.taskId,
          newStart: row.startsAt!.add(delta),
          newEnd: row.endsAt!.add(delta),
        );
  }

  void _commitResize(GanttRow row, double pxPerDay) {
    final dx = _resizeDx.remove(row.taskId) ?? 0;
    setState(() {});
    final growDays = (dx / pxPerDay).round();
    if (growDays == 0) return;
    var newEnd = row.endsAt!.add(Duration(days: growDays));
    // Keep at least a one-day bar.
    if (newEnd.isBefore(row.startsAt!)) {
      newEnd = row.startsAt!;
    }
    ref.read(ganttControllerProvider.notifier).moveBar(
          row.taskId,
          newStart: row.startsAt!,
          newEnd: newEnd,
        );
  }

  String _barTooltip(GanttRow row) {
    String d(DateTime? t) =>
        t == null ? '—' : '${t.year}/${t.month}/${t.day}';
    return '${row.title}\n${d(row.startsAt)} → ${d(row.endsAt)}  (${row.progressPercent}%)';
  }
}

class _LeftPane extends StatelessWidget {
  const _LeftPane({required this.rows});
  final List<GanttRow> rows;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SizedBox(
      width: _leftPaneWidth,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            height: _axisHeight,
            alignment: Alignment.centerLeft,
            padding: const EdgeInsets.only(left: 12),
            decoration: BoxDecoration(
              border: Border(
                bottom: BorderSide(color: theme.colorScheme.outlineVariant),
              ),
            ),
            child: Text('タスク',
                style: theme.textTheme.labelMedium
                    ?.copyWith(color: theme.colorScheme.outline)),
          ),
          for (final r in rows)
            Container(
              height: _rowHeight,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              alignment: Alignment.centerLeft,
              decoration: BoxDecoration(
                border: Border(
                  bottom:
                      BorderSide(color: theme.colorScheme.outlineVariant),
                ),
              ),
              child: Row(
                children: [
                  Icon(
                    r.isScheduled
                        ? Icons.check_box_outline_blank
                        : Icons.remove,
                    size: 14,
                    color: theme.colorScheme.outline,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      r.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodyMedium,
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _Axis extends StatelessWidget {
  const _Axis({
    required this.rangeStart,
    required this.totalDays,
    required this.pxPerDay,
    required this.zoom,
  });

  final DateTime rangeStart;
  final int totalDays;
  final double pxPerDay;
  final GanttZoom zoom;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      height: _axisHeight,
      decoration: BoxDecoration(
        border: Border(
          bottom: BorderSide(color: theme.colorScheme.outlineVariant),
        ),
      ),
      child: Stack(
        children: [
          for (final tick in _ticks())
            Positioned(
              left: tick.offsetDays * pxPerDay + 2,
              top: 6,
              child: Text(
                tick.label,
                style: theme.textTheme.labelSmall
                    ?.copyWith(color: theme.colorScheme.outline),
              ),
            ),
        ],
      ),
    );
  }

  List<({int offsetDays, String label})> _ticks() {
    final out = <({int offsetDays, String label})>[];
    for (var i = 0; i < totalDays; i++) {
      final d = rangeStart.add(Duration(days: i));
      switch (zoom) {
        case GanttZoom.day:
          out.add((offsetDays: i, label: '${d.month}/${d.day}'));
          break;
        case GanttZoom.week:
          if (d.weekday == DateTime.monday) {
            out.add((offsetDays: i, label: '${d.month}/${d.day}'));
          }
          break;
        case GanttZoom.month:
          if (d.day == 1) {
            out.add((offsetDays: i, label: '${d.year}/${d.month}'));
          }
          break;
      }
    }
    return out;
  }
}

/// Paints the vertical day/period grid and the FS dependency connectors.
class _TimelinePainter extends CustomPainter {
  _TimelinePainter({
    required this.rows,
    required this.dependencies,
    required this.rangeStart,
    required this.totalDays,
    required this.pxPerDay,
    required this.gridColor,
    required this.depColor,
  });

  final List<GanttRow> rows;
  final List<GanttDependencyLine> dependencies;
  final DateTime rangeStart;
  final int totalDays;
  final double pxPerDay;
  final Color gridColor;
  final Color depColor;

  int _indexOf(String taskId) => rows.indexWhere((r) => r.taskId == taskId);
  double _x(DateTime d) =>
      _dateOnly(d).difference(rangeStart).inDays * pxPerDay;

  @override
  void paint(Canvas canvas, Size size) {
    final grid = Paint()
      ..color = gridColor.withValues(alpha: 0.5)
      ..strokeWidth = 1;
    // Vertical grid: draw sparser lines when zoomed out to avoid clutter.
    final step = pxPerDay >= 24 ? 1 : (pxPerDay >= 12 ? 7 : 30);
    for (var i = 0; i <= totalDays; i += step) {
      final x = i * pxPerDay;
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), grid);
    }
    // Horizontal row separators.
    for (var i = 0; i <= rows.length; i++) {
      final y = i * _rowHeight;
      canvas.drawLine(Offset(0, y), Offset(size.width, y), grid);
    }

    // FS dependency connectors: from predecessor's end to successor's start.
    final dep = Paint()
      ..color = depColor
      ..strokeWidth = 1.5
      ..style = PaintingStyle.stroke;
    for (final d in dependencies) {
      final fi = _indexOf(d.fromTaskId);
      final ti = _indexOf(d.toTaskId);
      if (fi < 0 || ti < 0) continue;
      final from = rows[fi];
      final to = rows[ti];
      if (!from.isScheduled || !to.isScheduled) continue;

      final fromEndX = _x(from.endsAt!) + pxPerDay; // right edge of the bar
      final fromY = fi * _rowHeight + _rowHeight / 2;
      final toStartX = _x(to.startsAt!);
      final toY = ti * _rowHeight + _rowHeight / 2;

      final path = Path()
        ..moveTo(fromEndX, fromY)
        ..lineTo(fromEndX + 8, fromY)
        ..lineTo(fromEndX + 8, toY)
        ..lineTo(toStartX, toY);
      canvas.drawPath(path, dep);
      // Arrowhead at the successor's start.
      final arrow = Path()
        ..moveTo(toStartX, toY)
        ..lineTo(toStartX - 6, toY - 4)
        ..lineTo(toStartX - 6, toY + 4)
        ..close();
      canvas.drawPath(arrow, Paint()..color = depColor);
    }
  }

  @override
  bool shouldRepaint(covariant _TimelinePainter old) =>
      old.rows != rows ||
      old.dependencies != dependencies ||
      old.pxPerDay != pxPerDay ||
      old.rangeStart != rangeStart;
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.timeline, size: 48, color: theme.colorScheme.outline),
          const SizedBox(height: 8),
          const Text('スケジュール済みのタスクがありません'),
        ],
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.message, required this.onRetry});
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.error_outline, size: 44, color: theme.colorScheme.error),
          const SizedBox(height: 8),
          Text('読み込みに失敗しました', style: theme.textTheme.titleMedium),
          const SizedBox(height: 4),
          Text(message,
              style: theme.textTheme.bodySmall
                  ?.copyWith(color: theme.colorScheme.outline)),
          const SizedBox(height: 12),
          FilledButton.tonal(onPressed: onRetry, child: const Text('再試行')),
        ],
      ),
    );
  }
}
