import 'package:flutter/material.dart';

import 'app_registry_data.dart';

export 'app_registry_data.dart' show DesktopStatus;

/// The Flutter presentation view of one canonical desktop app: the pure-Dart
/// [DesktopAppData] (the parity-checked contract) plus a launcher icon.
@immutable
class DesktopApp {
  const DesktopApp(this.data, this.icon);

  final DesktopAppData data;
  final IconData icon;

  String get id => data.id;
  String get label => data.label;
  String get navPath => data.navPath;
  String get permission => data.permission;
  DesktopStatus get status => data.status;
  bool get openToAllAuthenticated => data.openToAllAuthenticated;
}

/// Launcher icons per app id (desktop-only presentation; not part of the
/// contract). Every id in [kDesktopAppData] must have an icon here.
const Map<String, IconData> _icons = {
  'events': Icons.event,
  'tasks': Icons.check_circle_outline,
  'gantt': Icons.view_timeline_outlined,
  'notifications': Icons.notifications_outlined,
  'chat': Icons.chat_bubble_outline,
  'mail': Icons.mail_outline,
  'usage': Icons.speed_outlined,
  'members': Icons.groups_outlined,
  'participation': Icons.how_to_reg_outlined,
  'driveshare': Icons.folder_shared_outlined,
  'admin': Icons.admin_panel_settings_outlined,
};

/// The canonical desktop apps, in launcher order, ready for the UI.
final List<DesktopApp> kDesktopApps = [
  for (final d in kDesktopAppData) DesktopApp(d, _icons[d.id] ?? Icons.apps),
];
