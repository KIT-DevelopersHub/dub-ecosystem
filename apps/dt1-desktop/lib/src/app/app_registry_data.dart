// Pure-Dart canonical desktop app data (NO Flutter imports) so a plain
// `dart run` tool can export it to JSON for the Node parity test. The Flutter
// presentation layer (app_registry.dart) wraps each entry with an icon.
//
// id / label / navPath / permission MUST mirror the web SoT `APP_MANIFEST`
// (packages/types/src/app-registry.ts). `status` is desktop-only: whether the
// screen is data-backed (live) or a registered placeholder (skeleton).

enum DesktopStatus { live, skeleton }

class DesktopAppData {
  const DesktopAppData({
    required this.id,
    required this.label,
    required this.navPath,
    required this.permission,
    required this.status,
    this.openToAllAuthenticated = false,
  });

  final String id;
  final String label;
  final String navPath;
  final String permission;
  final DesktopStatus status;
  final bool openToAllAuthenticated;
}

/// The canonical desktop app set, in launcher order — a 1:1 mirror of the web
/// `APP_MANIFEST` ids. The parity test reconciles this against @dub/types.
const List<DesktopAppData> kDesktopAppData = [
  DesktopAppData(id: 'events', label: 'イベント', navPath: '/events', permission: 'event:read', status: DesktopStatus.live),
  DesktopAppData(id: 'tasks', label: 'マイタスク', navPath: '/me/tasks', permission: 'task:read', status: DesktopStatus.live),
  DesktopAppData(id: 'gantt', label: 'ガントチャート', navPath: '/gantt', permission: 'task:read', status: DesktopStatus.live),
  DesktopAppData(id: 'notifications', label: '通知', navPath: '/notifications', permission: 'notif:inbox:self', status: DesktopStatus.live),
  DesktopAppData(id: 'chat', label: 'チャット', navPath: '/chat', permission: 'chat:create', status: DesktopStatus.skeleton),
  DesktopAppData(id: 'mail', label: 'メール', navPath: '/mail', permission: 'mail:read', status: DesktopStatus.skeleton),
  DesktopAppData(id: 'usage', label: '無料枠 / 課金ガード', navPath: '/usage', permission: 'usage:view', status: DesktopStatus.skeleton, openToAllAuthenticated: true),
  DesktopAppData(id: 'members', label: '運営メンバー', navPath: '/members', permission: 'identity:read', status: DesktopStatus.skeleton),
  DesktopAppData(id: 'participation', label: '参加届', navPath: '/participation', permission: 'identity:read', status: DesktopStatus.skeleton, openToAllAuthenticated: true),
  DesktopAppData(id: 'driveshare', label: 'Drive共有', navPath: '/driveshare', permission: 'drive:read', status: DesktopStatus.skeleton, openToAllAuthenticated: true),
  DesktopAppData(id: 'admin', label: '管理', navPath: '/admin/users', permission: 'identity:admin', status: DesktopStatus.skeleton),
];
