import 'package:flutter/material.dart';

/// The plug-in contract every feature implements.
///
/// One file per feature (`lib/features/<feature>/<feature>_module.dart`)
/// declares a single [FeatureModule]. The 9-dot launcher, the selected-app
/// navigation and the shell body are all derived from the registry
/// (`lib/features/modules.dart`), so adding a feature is: new folder + new
/// module file + one line in the registry — the shell is never edited.
///
/// See `docs/desktop-flutter/FEATURE_MODULE_GUIDE.md`.
abstract class FeatureModule {
  const FeatureModule();

  /// Stable unique id. Also the selected-feature key and launcher key.
  String get id;

  /// Launcher label (Japanese, web-parity).
  String get label;

  /// Launcher icon.
  IconData get icon;

  /// Whether this feature is released to the launcher (release-gating parity
  /// with the web launcher). When false it renders greyed-out with a lock and
  /// its body shows a "準備中" placeholder.
  bool get ready => true;

  /// The feature's root view, shown in the shell body when this app is selected.
  Widget buildView(BuildContext context);
}

/// A registry entry for a feature that is not built in the desktop client yet.
/// Keeps the launcher at web-parity (all apps visible, unbuilt ones locked).
/// A parallel agent replaces this one-line entry with their real module.
class ComingSoonModule extends FeatureModule {
  const ComingSoonModule({
    required this.id,
    required this.label,
    required this.icon,
  });

  @override
  final String id;
  @override
  final String label;
  @override
  final IconData icon;

  @override
  bool get ready => false;

  @override
  Widget buildView(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 56, color: theme.colorScheme.outline),
          const SizedBox(height: 12),
          Text('$label は準備中', style: theme.textTheme.titleMedium),
          const SizedBox(height: 4),
          Text(
            '共有APIに接続済み。Web と同じ機能をこの画面に載せていきます。',
            style: theme.textTheme.bodySmall
                ?.copyWith(color: theme.colorScheme.outline),
          ),
        ],
      ),
    );
  }
}
