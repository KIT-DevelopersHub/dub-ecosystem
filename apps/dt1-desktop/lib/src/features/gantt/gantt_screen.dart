import 'package:flutter/material.dart';

import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import '../events/events_repository.dart';
import 'gantt_repository.dart';

/// ガントチャート — an event's schedule rows (`GET /api/v1/gantt?eventId=`).
/// The user picks an event (from `GET /api/v1/events`); the first is selected by
/// default. The `eventId` query key is the one the PR#231 `?event=` bug broke —
/// here it flows from the desktop wire descriptor.
class GanttScreen extends StatefulWidget {
  const GanttScreen({
    super.key,
    required this.ganttRepository,
    required this.eventsRepository,
  });

  final GanttRepository ganttRepository;
  final EventsRepository eventsRepository;

  @override
  State<GanttScreen> createState() => _GanttScreenState();
}

class _GanttScreenState extends State<GanttScreen> {
  late Future<List<EventItem>> _events = widget.eventsRepository.fetchEvents();
  String? _selectedEventId;
  Future<GanttChart>? _chart;

  void _select(String eventId) {
    setState(() {
      _selectedEventId = eventId;
      _chart = widget.ganttRepository.fetchGantt(eventId: eventId);
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = AppTheme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 20, 24, 8),
          child: Text('ガントチャート', style: Theme.of(context).textTheme.headlineSmall),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 24),
          child: AsyncView<List<EventItem>>(
            future: _events,
            onRetry: () => setState(() => _events = widget.eventsRepository.fetchEvents()),
            emptyCheck: (list) => list.isEmpty,
            emptyLabel: 'イベントがないためガントを表示できません',
            onData: (context, events) {
              _selectedEventId ??= () {
                final first = events.first.id;
                WidgetsBinding.instance.addPostFrameCallback((_) => _select(first));
                return first;
              }();
              return Align(
                alignment: Alignment.centerLeft,
                child: DropdownButton<String>(
                  value: _selectedEventId,
                  onChanged: (v) => v != null ? _select(v) : null,
                  items: [
                    for (final e in events)
                      DropdownMenuItem(value: e.id, child: Text(e.title)),
                  ],
                ),
              );
            },
          ),
        ),
        const SizedBox(height: 8),
        Expanded(
          child: _chart == null
              ? Center(child: Text('イベントを選択してください', style: TextStyle(color: c.textMuted)))
              : AsyncView<GanttChart>(
                  future: _chart!,
                  onRetry: () =>
                      _selectedEventId != null ? _select(_selectedEventId!) : null,
                  emptyCheck: (chart) => chart.rows.isEmpty,
                  emptyLabel: 'このイベントにはスケジュールがありません',
                  onData: (context, chart) => ListView.separated(
                    padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 8),
                    itemCount: chart.rows.length,
                    separatorBuilder: (_, __) => const SizedBox(height: 8),
                    itemBuilder: (context, i) => _GanttRowTile(row: chart.rows[i]),
                  ),
                ),
        ),
      ],
    );
  }
}

class _GanttRowTile extends StatelessWidget {
  const _GanttRowTile({required this.row});

  final GanttRow row;

  @override
  Widget build(BuildContext context) {
    final c = AppTheme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(child: Text(row.title, style: const TextStyle(fontWeight: FontWeight.w500))),
                Text('${row.progressPercent}%', style: TextStyle(color: c.textMuted)),
              ],
            ),
            const SizedBox(height: 8),
            ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: LinearProgressIndicator(
                value: (row.progressPercent.clamp(0, 100)) / 100.0,
                minHeight: 6,
                backgroundColor: c.surfaceSunken,
                valueColor: AlwaysStoppedAnimation(c.brand),
              ),
            ),
            if (row.startsAt != null || row.endsAt != null) ...[
              const SizedBox(height: 6),
              Text(
                '${row.startsAt != null ? _fmtDate(row.startsAt!) : '—'} 〜 ${row.endsAt != null ? _fmtDate(row.endsAt!) : '—'}',
                style: TextStyle(color: c.textMuted, fontSize: 12),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

String _fmtDate(DateTime d) =>
    '${d.month.toString().padLeft(2, '0')}/${d.day.toString().padLeft(2, '0')}';
