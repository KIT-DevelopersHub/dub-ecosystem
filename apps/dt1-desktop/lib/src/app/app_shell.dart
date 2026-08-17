import 'package:dub_api_client/dub_api_client.dart';
import 'package:flutter/material.dart';

import '../features/events/events_screen.dart';
import '../features/gantt/gantt_screen.dart';
import '../features/home/home_screen.dart';
import '../features/me/profile_screen.dart';
import '../features/notifications/notifications_screen.dart';
import '../features/tasks/tasks_screen.dart';
import '../theme/app_theme.dart';
import '../widgets/placeholder_screen.dart';
import 'app_registry.dart';
import 'services.dart';

/// The signed-in shell: a left launcher rail (Home + Profile + the canonical
/// [kDesktopApps]) and a content pane. Apps the user lacks permission for are
/// greyed out and non-selectable, matching the web launcher's per-app RBAC.
class AppShell extends StatefulWidget {
  const AppShell({super.key, required this.services, required this.me});

  final AppServices services;
  final MeResponse me;

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  /// Selected destination id: 'home', 'profile', or a [DesktopApp.id].
  String _selected = 'home';

  bool _allowed(DesktopApp app) =>
      app.openToAllAuthenticated || widget.services.auth.can(app.permission);

  @override
  Widget build(BuildContext context) {
    final c = AppTheme.of(context);
    return Scaffold(
      body: Row(
        children: [
          _Sidebar(
            selected: _selected,
            userName: widget.me.user.displayName,
            apps: kDesktopApps,
            allowed: _allowed,
            onSelect: (id) => setState(() => _selected = id),
          ),
          const VerticalDivider(width: 1),
          Expanded(
            child: Container(
              color: c.surfaceSunken,
              child: _content(),
            ),
          ),
        ],
      ),
    );
  }

  Widget _content() {
    final s = widget.services;
    switch (_selected) {
      case 'home':
        return HomeScreen(repository: s.home, userName: widget.me.user.displayName);
      case 'profile':
        return ProfileScreen(meRepository: s.me, onLogout: s.auth.logout);
      case 'events':
        return EventsScreen(repository: s.events);
      case 'tasks':
        return TasksScreen(repository: s.tasks, userId: widget.me.user.id);
      case 'gantt':
        return GanttScreen(ganttRepository: s.gantt, eventsRepository: s.events);
      case 'notifications':
        return NotificationsScreen(repository: s.notifications);
      default:
        final app = kDesktopApps.firstWhere((a) => a.id == _selected);
        return PlaceholderScreen(app: app);
    }
  }
}

class _Sidebar extends StatelessWidget {
  const _Sidebar({
    required this.selected,
    required this.userName,
    required this.apps,
    required this.allowed,
    required this.onSelect,
  });

  final String selected;
  final String userName;
  final List<DesktopApp> apps;
  final bool Function(DesktopApp) allowed;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    final c = AppTheme.of(context);
    return Container(
      width: 232,
      color: c.surfaceBase,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 20, 16, 16),
            child: Row(
              children: [
                Container(
                  height: 32,
                  width: 32,
                  decoration: BoxDecoration(
                    color: c.brand,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: const Icon(Icons.hub, color: Colors.white, size: 20),
                ),
                const SizedBox(width: 10),
                const Text('DevHub', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
              ],
            ),
          ),
          _NavTile(
            icon: Icons.dashboard_outlined,
            label: 'ホーム',
            selected: selected == 'home',
            enabled: true,
            onTap: () => onSelect('home'),
          ),
          _NavTile(
            icon: Icons.person_outline,
            label: 'プロフィール',
            selected: selected == 'profile',
            enabled: true,
            onTap: () => onSelect('profile'),
          ),
          const Divider(height: 16),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 4, 20, 8),
            child: Text('アプリ',
                style: TextStyle(color: c.textMuted, fontSize: 11, fontWeight: FontWeight.w600)),
          ),
          Expanded(
            child: ListView(
              padding: EdgeInsets.zero,
              children: [
                for (final app in apps)
                  _NavTile(
                    icon: app.icon,
                    label: app.label,
                    selected: selected == app.id,
                    enabled: allowed(app),
                    trailing: app.status == DesktopStatus.skeleton
                        ? Icon(Icons.schedule, size: 13, color: c.textMuted)
                        : null,
                    onTap: allowed(app) ? () => onSelect(app.id) : null,
                  ),
              ],
            ),
          ),
          const Divider(height: 1),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                CircleAvatar(
                  radius: 14,
                  backgroundColor: c.brandSoft,
                  child: Text(
                    userName.characters.first.toUpperCase(),
                    style: const TextStyle(fontSize: 13, color: Colors.white),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(userName,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 13)),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _NavTile extends StatelessWidget {
  const _NavTile({
    required this.icon,
    required this.label,
    required this.selected,
    required this.enabled,
    required this.onTap,
    this.trailing,
  });

  final IconData icon;
  final String label;
  final bool selected;
  final bool enabled;
  final VoidCallback? onTap;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final c = AppTheme.of(context);
    final fg = !enabled
        ? c.textMuted.withValues(alpha: 0.5)
        : selected
            ? c.brand
            : c.textSecondary;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      child: Material(
        color: selected ? c.brandSoft.withValues(alpha: 0.16) : Colors.transparent,
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(8),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Row(
              children: [
                Icon(icon, size: 20, color: fg),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(label,
                      style: TextStyle(
                        color: fg,
                        fontWeight: selected ? FontWeight.w600 : FontWeight.normal,
                        fontSize: 14,
                      )),
                ),
                if (trailing != null) trailing!,
              ],
            ),
          ),
        ),
      ),
    );
  }
}
