import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// A tiny load/error/data scaffold shared by the feature screens so each screen
/// gets a consistent spinner, error card (with retry) and content, without
/// repeating FutureBuilder boilerplate.
class AsyncView<T> extends StatelessWidget {
  const AsyncView({
    super.key,
    required this.future,
    required this.onData,
    required this.onRetry,
    this.emptyCheck,
    this.emptyLabel = 'データがありません',
  });

  final Future<T> future;
  final Widget Function(BuildContext, T) onData;
  final VoidCallback onRetry;
  final bool Function(T)? emptyCheck;
  final String emptyLabel;

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<T>(
      future: future,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snapshot.hasError) {
          return _ErrorCard(error: snapshot.error!, onRetry: onRetry);
        }
        final data = snapshot.data as T;
        if (emptyCheck?.call(data) ?? false) {
          return _Empty(label: emptyLabel);
        }
        return onData(context, data);
      },
    );
  }
}

class _ErrorCard extends StatelessWidget {
  const _ErrorCard({required this.error, required this.onRetry});

  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final c = AppTheme.of(context);
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 420),
        child: Card(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.error_outline, color: c.danger, size: 36),
                const SizedBox(height: 12),
                Text('$error', textAlign: TextAlign.center),
                const SizedBox(height: 16),
                FilledButton.tonal(onPressed: onRetry, child: const Text('再試行')),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final c = AppTheme.of(context);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.inbox_outlined, color: c.textMuted, size: 40),
          const SizedBox(height: 8),
          Text(label, style: TextStyle(color: c.textMuted)),
        ],
      ),
    );
  }
}
