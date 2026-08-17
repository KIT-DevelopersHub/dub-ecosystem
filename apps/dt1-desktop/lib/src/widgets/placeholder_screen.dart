import 'package:flutter/material.dart';

import '../app/app_registry.dart';
import '../theme/app_theme.dart';

/// Shown for apps that are registered in the desktop launcher (so parity CI
/// passes and the tile is present) but whose data-backed screen is still being
/// built. Honest about status rather than faking a working app.
class PlaceholderScreen extends StatelessWidget {
  const PlaceholderScreen({super.key, required this.app});

  final DesktopApp app;

  @override
  Widget build(BuildContext context) {
    final c = AppTheme.of(context);
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 440),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(app.icon, size: 48, color: c.brand),
            const SizedBox(height: 16),
            Text(app.label, style: Theme.of(context).textTheme.headlineSmall),
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: BoxDecoration(
                color: c.surfaceSunken,
                borderRadius: BorderRadius.circular(999),
                border: Border.all(color: c.borderDefault),
              ),
              child: Text('デスクトップ版は準備中',
                  style: TextStyle(color: c.textMuted, fontSize: 12)),
            ),
            const SizedBox(height: 16),
            Text(
              'この機能はWeb版で利用できます。デスクトップ版は近日対応予定です。',
              textAlign: TextAlign.center,
              style: TextStyle(color: c.textSecondary),
            ),
          ],
        ),
      ),
    );
  }
}
