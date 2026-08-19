import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/models.dart';
import '../state/events.dart';
import 'shared.dart';

/// Events app: a list of events (`GET /api/v1/events`), each opening a simple
/// detail sheet with its actions (`GET /api/v1/events/{id}`).
class EventsView extends ConsumerWidget {
  const EventsView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(eventsProvider);
    final theme = Theme.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 20, 24, 8),
          child: Row(
            children: [
              Text('イベント', style: theme.textTheme.headlineSmall),
              const Spacer(),
              IconButton(
                tooltip: '再読み込み',
                icon: const Icon(Icons.refresh),
                onPressed: () => ref.invalidate(eventsProvider),
              ),
            ],
          ),
        ),
        Expanded(
          child: async.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (e, _) => FeatureErrorState(
              error: e,
              onRetry: () => ref.invalidate(eventsProvider),
            ),
            data: (page) => page.items.isEmpty
                ? const FeatureEmptyState(
                    icon: Icons.event_busy_outlined,
                    message: 'イベントはありません',
                  )
                : ListView.separated(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 24, vertical: 8),
                    itemCount: page.items.length,
                    separatorBuilder: (_, __) => const SizedBox(height: 8),
                    itemBuilder: (_, i) => _EventTile(event: page.items[i]),
                  ),
          ),
        ),
      ],
    );
  }
}

class _EventTile extends StatelessWidget {
  const _EventTile({required this.event});
  final EventSummary event;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Material(
      color: theme.colorScheme.surface,
      borderRadius: BorderRadius.circular(12),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: () => _openDetail(context, event.id),
        child: Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: theme.colorScheme.outlineVariant),
          ),
          child: Row(
            children: [
              Icon(Icons.event_outlined, color: theme.colorScheme.primary),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(event.title,
                        style: theme.textTheme.titleSmall
                            ?.copyWith(fontWeight: FontWeight.w600)),
                    const SizedBox(height: 4),
                    Text(
                      formatWhen(event.startsAt) ?? '日時未定',
                      style: theme.textTheme.bodySmall
                          ?.copyWith(color: theme.colorScheme.outline),
                    ),
                  ],
                ),
              ),
              PhaseChip(phase: event.phase),
              const SizedBox(width: 4),
              Icon(Icons.chevron_right, color: theme.colorScheme.outline),
            ],
          ),
        ),
      ),
    );
  }

  void _openDetail(BuildContext context, String id) {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (_) => FractionallySizedBox(
        heightFactor: 0.8,
        child: _EventDetailSheet(eventId: id),
      ),
    );
  }
}

class _EventDetailSheet extends ConsumerWidget {
  const _EventDetailSheet({required this.eventId});
  final String eventId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(eventDetailProvider(eventId));
    final theme = Theme.of(context);

    return async.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => FeatureErrorState(
        error: e,
        onRetry: () => ref.invalidate(eventDetailProvider(eventId)),
      ),
      data: (detail) => ListView(
        padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
        children: [
          Row(
            children: [
              Expanded(
                child: Text(detail.title,
                    style: theme.textTheme.headlineSmall),
              ),
              const SizedBox(width: 8),
              PhaseChip(phase: detail.phase),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            formatWhen(detail.startsAt) ?? '日時未定',
            style: theme.textTheme.bodyMedium
                ?.copyWith(color: theme.colorScheme.outline),
          ),
          if (detail.description != null &&
              detail.description!.isNotEmpty) ...[
            const SizedBox(height: 16),
            Text(detail.description!, style: theme.textTheme.bodyMedium),
          ],
          const SizedBox(height: 24),
          Text('アクション (${detail.actions.length})',
              style: theme.textTheme.titleMedium),
          const SizedBox(height: 8),
          if (detail.actions.isEmpty)
            Text('アクションはまだありません',
                style: theme.textTheme.bodySmall
                    ?.copyWith(color: theme.colorScheme.outline))
          else
            for (final a in detail.actions)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.play_circle_outline),
                title: Text(a.title),
                subtitle: Text(a.kind),
              ),
        ],
      ),
    );
  }
}
