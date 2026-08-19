import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/feature_module.dart';
import '../features/modules.dart';
import '../state/auth.dart';

/// The currently selected feature id. Defaults to the first registered module.
final selectedFeatureProvider = StateProvider<String>((_) => defaultFeatureId);

/// The app shell: top bar with the 9-dot launcher + account menu, and a body
/// rendered from the selected [FeatureModule]. Fully registry-driven — adding a
/// feature never edits this file (see FEATURE_MODULE_GUIDE.md).
class AppShell extends ConsumerWidget {
  const AppShell({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final modules = ref.watch(featureModulesProvider);
    final selectedId = ref.watch(selectedFeatureProvider);
    final me = ref.watch(authControllerProvider).me;
    final theme = Theme.of(context);

    final selected = modules.firstWhere(
      (m) => m.id == selectedId,
      orElse: () => modules.first,
    );

    return Scaffold(
      appBar: AppBar(
        titleSpacing: 12,
        title: Row(
          children: [
            const _AppLauncherButton(),
            const SizedBox(width: 12),
            Container(
              width: 28,
              height: 28,
              decoration: BoxDecoration(
                color: theme.colorScheme.primary,
                borderRadius: BorderRadius.circular(7),
              ),
              alignment: Alignment.center,
              child: const Text('D',
                  style: TextStyle(
                      color: Colors.white, fontWeight: FontWeight.bold)),
            ),
            const SizedBox(width: 10),
            const Text('DAV Desktop'),
            const SizedBox(width: 10),
            Icon(Icons.chevron_right, size: 18, color: theme.colorScheme.outline),
            const SizedBox(width: 6),
            Text(
              selected.label,
              style: theme.textTheme.titleMedium
                  ?.copyWith(color: theme.colorScheme.outline),
            ),
          ],
        ),
        actions: [
          if (me != null)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: Center(
                child: Text(
                  me.user.displayName,
                  style: theme.textTheme.bodyMedium,
                ),
              ),
            ),
          PopupMenuButton<String>(
            tooltip: 'アカウント',
            icon: CircleAvatar(
              radius: 15,
              backgroundColor: theme.colorScheme.primaryContainer,
              child: Text(
                _initial(me?.user.displayName),
                style: TextStyle(color: theme.colorScheme.onPrimaryContainer),
              ),
            ),
            onSelected: (v) {
              if (v == 'logout') {
                ref.read(authControllerProvider.notifier).logout();
              }
            },
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'logout', child: Text('ログアウト')),
            ],
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: selected.buildView(context),
    );
  }

  static String _initial(String? name) {
    if (name == null || name.isEmpty) return '?';
    return name.characters.first.toUpperCase();
  }
}

class _AppLauncherButton extends ConsumerWidget {
  const _AppLauncherButton();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return IconButton(
      tooltip: 'アプリ',
      icon: const Icon(Icons.apps),
      onPressed: () => _openLauncher(context, ref),
    );
  }

  void _openLauncher(BuildContext context, WidgetRef ref) {
    final modules = ref.read(featureModulesProvider);
    showDialog<void>(
      context: context,
      barrierColor: Colors.black26,
      builder: (ctx) {
        return Dialog(
          alignment: Alignment.topLeft,
          insetPadding: const EdgeInsets.only(top: 56, left: 8),
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
          child: Container(
            width: 320,
            padding: const EdgeInsets.all(16),
            child: GridView.count(
              crossAxisCount: 3,
              shrinkWrap: true,
              mainAxisSpacing: 8,
              crossAxisSpacing: 8,
              children: [
                for (final module in modules)
                  _LauncherTile(
                    module: module,
                    onTap: () {
                      ref.read(selectedFeatureProvider.notifier).state =
                          module.id;
                      Navigator.of(ctx).pop();
                    },
                  ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _LauncherTile extends StatelessWidget {
  const _LauncherTile({required this.module, required this.onTap});
  final FeatureModule module;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Stack(
            children: [
              Icon(module.icon,
                  size: 30,
                  color: module.ready
                      ? theme.colorScheme.primary
                      : theme.colorScheme.outline),
              if (!module.ready)
                const Positioned(
                  right: 0,
                  top: 0,
                  child: Icon(Icons.lock_outline, size: 12),
                ),
            ],
          ),
          const SizedBox(height: 6),
          Text(module.label, style: theme.textTheme.bodySmall),
        ],
      ),
    );
  }
}
