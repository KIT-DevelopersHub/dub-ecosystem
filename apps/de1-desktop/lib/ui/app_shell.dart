import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/app_lock.dart';
import '../state/auth.dart';
import 'inbox_view.dart';

/// One launchable app in the ecosystem (mirrors the web 9-dot launcher).
class DubApp {
  const DubApp(this.id, this.label, this.icon, {this.ready = false});
  final String id;
  final String label;
  final IconData icon;

  /// Whether this app is implemented in the desktop client yet.
  final bool ready;
}

const _apps = <DubApp>[
  DubApp('notifications', '通知', Icons.notifications_outlined, ready: true),
  DubApp('chat', 'チャット', Icons.chat_bubble_outline),
  DubApp('tasks', 'タスク', Icons.check_circle_outline),
  DubApp('gantt', 'ガント', Icons.timeline),
  DubApp('mail', 'メール', Icons.mail_outline),
  DubApp('events', 'イベント', Icons.event_outlined),
  DubApp('roster', '名簿', Icons.groups_outlined),
  DubApp('drive', 'ドライブ', Icons.folder_outlined),
];

final selectedAppProvider = StateProvider<String>((_) => 'notifications');

class AppShell extends ConsumerWidget {
  const AppShell({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final selectedId = ref.watch(selectedAppProvider);
    final me = ref.watch(authControllerProvider).me;
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        titleSpacing: 12,
        title: Row(
          children: [
            _AppLauncherButton(),
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
              } else if (v == 'settings') {
                _openSettings(context);
              }
            },
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'settings', child: Text('設定')),
              PopupMenuItem(value: 'logout', child: Text('ログアウト')),
            ],
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: _AppBody(selectedId: selectedId),
    );
  }

  static String _initial(String? name) {
    if (name == null || name.isEmpty) return '?';
    return name.characters.first.toUpperCase();
  }
}

void _openSettings(BuildContext context) {
  showDialog<void>(
    context: context,
    builder: (_) => const _SettingsDialog(),
  );
}

/// App settings. Currently hosts the device-level biometric launch gate toggle
/// (Touch ID on macOS, Windows Hello on Windows).
class _SettingsDialog extends ConsumerWidget {
  const _SettingsDialog();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final lock = ref.watch(appLockControllerProvider);
    final theme = Theme.of(context);

    return AlertDialog(
      title: const Text('設定'),
      content: SizedBox(
        width: 380,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              value: lock.enabled,
              onChanged: lock.supported
                  ? (v) => ref
                      .read(appLockControllerProvider.notifier)
                      .setEnabled(v)
                  : null,
              title: const Text('起動時に生体認証でロック'),
              subtitle: Text(
                lock.supported
                    ? '次回の起動から、Touch ID / Windows Hello（またはパスコード）で本人確認します。'
                    : 'この端末では生体認証・パスコードが利用できないため無効です。',
                style: theme.textTheme.bodySmall,
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('閉じる'),
        ),
      ],
    );
  }
}

class _AppBody extends StatelessWidget {
  const _AppBody({required this.selectedId});
  final String selectedId;

  @override
  Widget build(BuildContext context) {
    switch (selectedId) {
      case 'notifications':
        return const InboxView();
      default:
        final app = _apps.firstWhere((a) => a.id == selectedId,
            orElse: () => _apps.first);
        return _ComingSoon(app: app);
    }
  }
}

class _AppLauncherButton extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return IconButton(
      tooltip: 'アプリ',
      icon: const Icon(Icons.apps),
      onPressed: () => _openLauncher(context, ref),
    );
  }

  void _openLauncher(BuildContext context, WidgetRef ref) {
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
                for (final app in _apps)
                  _LauncherTile(
                    app: app,
                    onTap: () {
                      ref.read(selectedAppProvider.notifier).state = app.id;
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
  const _LauncherTile({required this.app, required this.onTap});
  final DubApp app;
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
              Icon(app.icon,
                  size: 30,
                  color: app.ready
                      ? theme.colorScheme.primary
                      : theme.colorScheme.outline),
              if (!app.ready)
                const Positioned(
                  right: 0,
                  top: 0,
                  child: Icon(Icons.lock_outline, size: 12),
                ),
            ],
          ),
          const SizedBox(height: 6),
          Text(app.label, style: theme.textTheme.bodySmall),
        ],
      ),
    );
  }
}

class _ComingSoon extends StatelessWidget {
  const _ComingSoon({required this.app});
  final DubApp app;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(app.icon, size: 56, color: theme.colorScheme.outline),
          const SizedBox(height: 12),
          Text('${app.label} は準備中', style: theme.textTheme.titleMedium),
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
