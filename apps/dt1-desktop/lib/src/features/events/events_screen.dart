import 'package:flutter/material.dart';

import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import 'events_repository.dart';

/// イベント — the org's events (`GET /api/v1/events`).
class EventsScreen extends StatefulWidget {
  const EventsScreen({super.key, required this.repository});

  final EventsRepository repository;

  @override
  State<EventsScreen> createState() => _EventsScreenState();
}

class _EventsScreenState extends State<EventsScreen> {
  late Future<List<EventItem>> _future = widget.repository.fetchEvents();

  void _reload() => setState(() => _future = widget.repository.fetchEvents());

  @override
  Widget build(BuildContext context) {
    final c = AppTheme.of(context);
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 20, 24, 8),
          child: Row(
            children: [
              Text('イベント', style: Theme.of(context).textTheme.headlineSmall),
              const Spacer(),
              IconButton(onPressed: _reload, icon: const Icon(Icons.refresh)),
            ],
          ),
        ),
        Expanded(
          child: AsyncView<List<EventItem>>(
            future: _future,
            onRetry: _reload,
            emptyCheck: (list) => list.isEmpty,
            emptyLabel: 'イベントはありません',
            onData: (context, items) => ListView.separated(
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 8),
              itemCount: items.length,
              separatorBuilder: (_, __) => const SizedBox(height: 8),
              itemBuilder: (context, i) {
                final e = items[i];
                return Card(
                  child: ListTile(
                    leading: Icon(Icons.event, color: c.brand),
                    title: Text(e.title),
                    subtitle: Text(e.startsAt != null
                        ? '${_fmtDate(e.startsAt!)}${e.endsAt != null ? ' 〜 ${_fmtDate(e.endsAt!)}' : ''}'
                        : e.phase),
                    trailing: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: c.surfaceSunken,
                        borderRadius: BorderRadius.circular(999),
                        border: Border.all(color: c.borderDefault),
                      ),
                      child: Text(e.phase, style: TextStyle(color: c.textMuted, fontSize: 11)),
                    ),
                  ),
                );
              },
            ),
          ),
        ),
      ],
    );
  }
}

String _fmtDate(DateTime d) =>
    '${d.year}/${d.month.toString().padLeft(2, '0')}/${d.day.toString().padLeft(2, '0')}';
