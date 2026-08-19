import 'package:flutter/material.dart';

import '../api/models.dart';

/// Reusable "failed to load" panel with a retry button. Decodes the
/// `@dub/errors` envelope when the error is a [DubApiException].
class FeatureErrorState extends StatelessWidget {
  const FeatureErrorState({super.key, required this.error, required this.onRetry});
  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final message =
        error is DubApiException ? (error as DubApiException).message : '$error';
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

/// Reusable empty-state placeholder.
class FeatureEmptyState extends StatelessWidget {
  const FeatureEmptyState({super.key, required this.icon, required this.message});
  final IconData icon;
  final String message;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 48, color: theme.colorScheme.outline),
          const SizedBox(height: 8),
          Text(message),
        ],
      ),
    );
  }
}

/// Small coloured chip for an event phase (planning/preparing/open/live/…).
class PhaseChip extends StatelessWidget {
  const PhaseChip({super.key, required this.phase});
  final String phase;

  static const _labels = <String, String>{
    'planning': '企画中',
    'preparing': '準備中',
    'open': '受付中',
    'live': '開催中',
    'wrapup': '事後',
    'closed': '終了',
  };

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final live = phase == 'live' || phase == 'open';
    final closed = phase == 'closed';
    final bg = closed
        ? theme.colorScheme.surfaceContainerHighest
        : live
            ? theme.colorScheme.primaryContainer
            : theme.colorScheme.secondaryContainer;
    final fg = closed
        ? theme.colorScheme.onSurfaceVariant
        : live
            ? theme.colorScheme.onPrimaryContainer
            : theme.colorScheme.onSecondaryContainer;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        _labels[phase] ?? phase,
        style: theme.textTheme.labelSmall?.copyWith(color: fg),
      ),
    );
  }
}

/// Formats an ISO8601 UTC timestamp into a short local `YYYY/MM/DD HH:mm`
/// string. Returns null for null/empty/unparseable input.
String? formatWhen(String? iso) {
  if (iso == null || iso.isEmpty) return null;
  final dt = DateTime.tryParse(iso);
  if (dt == null) return null;
  final l = dt.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${l.year}/${two(l.month)}/${two(l.day)} ${two(l.hour)}:${two(l.minute)}';
}
