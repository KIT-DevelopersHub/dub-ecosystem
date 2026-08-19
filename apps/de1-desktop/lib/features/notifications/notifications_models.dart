/// Notification-feature wire models (notification service, via gateway
/// `/api/v1/notifications/inbox`). Feature-owned — not in shared `api/models.dart`.
class InboxItem {
  const InboxItem({
    required this.id,
    required this.type,
    required this.title,
    required this.body,
    required this.readAt,
    required this.createdAt,
    this.resourceType,
    this.resourceId,
  });

  final String id;
  final String type;
  final String title;
  final String body;

  /// ISO8601 or null when unread.
  final String? readAt;

  /// ISO8601 UTC
  final String createdAt;
  final String? resourceType;
  final String? resourceId;

  bool get isUnread => readAt == null;

  factory InboxItem.fromJson(Map<String, dynamic> json) => InboxItem(
        id: json['id'] as String,
        type: json['type'] as String,
        title: json['title'] as String,
        body: json['body'] as String,
        readAt: json['readAt'] as String?,
        createdAt: json['createdAt'] as String,
        resourceType: json['resourceType'] as String?,
        resourceId: json['resourceId'] as String?,
      );
}

/// notification service PaginatedInbox.
class PaginatedInbox {
  const PaginatedInbox({required this.items, required this.nextCursor});

  final List<InboxItem> items;

  /// null = end of results.
  final String? nextCursor;

  factory PaginatedInbox.fromJson(Map<String, dynamic> json) => PaginatedInbox(
        items: (json['items'] as List<dynamic>? ?? const [])
            .map((e) => InboxItem.fromJson(e as Map<String, dynamic>))
            .toList(),
        nextCursor: json['nextCursor'] as String?,
      );
}
