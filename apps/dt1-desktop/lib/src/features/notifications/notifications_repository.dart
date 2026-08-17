import '../../api/proxy_repository.dart';
import '../../api/wire.dart';

/// One inbox notification (notification.yaml `InboxItem`). Keys match the spec.
class InboxNotification {
  InboxNotification({
    required this.id,
    required this.type,
    required this.title,
    required this.body,
    required this.readAt,
    required this.createdAt,
  });

  final String id;
  final String type;
  final String title;
  final String body;
  final DateTime? readAt;
  final DateTime? createdAt;

  bool get isUnread => readAt == null;

  factory InboxNotification.fromJson(Map<String, Object?> j) => InboxNotification(
        id: asString(j['id']),
        type: asString(j['type']),
        title: asString(j['title']),
        body: asString(j['body']),
        readAt: asDate(j['readAt']),
        createdAt: asDate(j['createdAt']),
      );
}

/// Reads the caller's notification inbox through the gateway proxy
/// (`GET /api/v1/notifications/inbox`). Query keys come from [kDesktopWire] —
/// never hand-written — so a `?unread=`-class drift fails the desktop-wire test.
class NotificationsRepository {
  NotificationsRepository(this._proxy);

  final ProxyClient _proxy;

  Future<List<InboxNotification>> fetchInbox({bool unreadOnly = false, int limit = 30}) async {
    final op = kDesktopWire['listInbox']!;
    final query = buildQuery(op, {
      'unreadOnly': unreadOnly ? 'true' : null,
      'limit': '$limit',
    });
    final body = await _proxy.getJson('/api/v1/notifications/inbox$query');
    return asItems(body).map(InboxNotification.fromJson).toList();
  }
}
