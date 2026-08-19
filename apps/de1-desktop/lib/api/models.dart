/// Dart mirrors of the shared wire contract (`@dub/types`, documented in
/// `docs/openapi/*.yaml`). These are hand-written for the vertical slice; the
/// architecture doc recommends generating them from the OpenAPI specs so the
/// single-source-of-truth contract is never duplicated by hand long-term.
library;

/// api-gateway `/api/v1/me` -> MeResponse.user (UserSummary).
class UserSummary {
  const UserSummary({
    required this.id,
    required this.displayName,
    this.avatarUrl,
  });

  final String id;
  final String displayName;
  final String? avatarUrl;

  factory UserSummary.fromJson(Map<String, dynamic> json) => UserSummary(
        id: json['id'] as String,
        displayName: json['displayName'] as String,
        avatarUrl: json['avatarUrl'] as String?,
      );
}

/// api-gateway `/api/v1/me` -> MeResponse.
class MeResponse {
  const MeResponse({
    required this.user,
    required this.orgId,
    required this.permissions,
    required this.sessionExpiresAt,
  });

  final UserSummary user;
  final String orgId;
  final List<String> permissions;

  /// epoch-ms
  final int sessionExpiresAt;

  factory MeResponse.fromJson(Map<String, dynamic> json) => MeResponse(
        user: UserSummary.fromJson(json['user'] as Map<String, dynamic>),
        orgId: json['orgId'] as String,
        permissions: (json['permissions'] as List<dynamic>? ?? const [])
            .map((e) => e as String)
            .toList(),
        sessionExpiresAt: json['sessionExpiresAt'] as int,
      );
}

/// auth-service `/auth/password/login` -> TokenSessionResponse.
class TokenSessionResponse {
  const TokenSessionResponse({required this.token, required this.session});

  final String token;
  final SessionInfo session;

  factory TokenSessionResponse.fromJson(Map<String, dynamic> json) =>
      TokenSessionResponse(
        token: json['token'] as String,
        session:
            SessionInfo.fromJson(json['session'] as Map<String, dynamic>),
      );
}

/// auth-service SessionInfo.
class SessionInfo {
  const SessionInfo({
    required this.userId,
    required this.client,
    required this.sessionExpiresAt,
  });

  final String userId;
  final String client;
  final int sessionExpiresAt;

  factory SessionInfo.fromJson(Map<String, dynamic> json) => SessionInfo(
        userId: json['userId'] as String,
        client: json['client'] as String,
        sessionExpiresAt: json['sessionExpiresAt'] as int,
      );
}

/// notification service InboxItem (via gateway `/api/v1/notifications/inbox`).
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

/// event-service EventSummary (via gateway `/api/v1/events`).
class EventSummary {
  const EventSummary({
    required this.id,
    required this.title,
    required this.phase,
    this.startsAt,
  });

  final String id;
  final String title;

  /// One of: planning, preparing, open, live, wrapup, closed.
  final String phase;

  /// ISO8601 UTC, or null when unscheduled.
  final String? startsAt;

  factory EventSummary.fromJson(Map<String, dynamic> json) => EventSummary(
        id: json['id'] as String,
        title: json['title'] as String,
        phase: json['phase'] as String,
        startsAt: json['startsAt'] as String?,
      );
}

/// event-service PaginatedEvents.
class PaginatedEvents {
  const PaginatedEvents({required this.items, required this.nextCursor});

  final List<EventSummary> items;

  /// null = end of results.
  final String? nextCursor;

  factory PaginatedEvents.fromJson(Map<String, dynamic> json) =>
      PaginatedEvents(
        items: (json['items'] as List<dynamic>? ?? const [])
            .map((e) => EventSummary.fromJson(e as Map<String, dynamic>))
            .toList(),
        nextCursor: json['nextCursor'] as String?,
      );
}

/// event-service ActionSummary (an action under an event).
class ActionSummary {
  const ActionSummary({
    required this.id,
    required this.eventId,
    required this.kind,
    required this.title,
  });

  final String id;
  final String eventId;
  final String kind;
  final String title;

  factory ActionSummary.fromJson(Map<String, dynamic> json) => ActionSummary(
        id: json['id'] as String,
        eventId: json['eventId'] as String,
        kind: json['kind'] as String,
        title: json['title'] as String,
      );
}

/// event-service EventDetail (DubEvent + its actions).
class EventDetail {
  const EventDetail({
    required this.id,
    required this.title,
    required this.phase,
    required this.actions,
    this.description,
    this.startsAt,
    this.endsAt,
    this.version,
  });

  final String id;
  final String title;
  final String phase;
  final List<ActionSummary> actions;
  final String? description;
  final String? startsAt;
  final String? endsAt;

  /// optimistic-lock version.
  final int? version;

  factory EventDetail.fromJson(Map<String, dynamic> json) => EventDetail(
        id: json['id'] as String,
        title: json['title'] as String,
        phase: json['phase'] as String,
        description: json['description'] as String?,
        startsAt: json['startsAt'] as String?,
        endsAt: json['endsAt'] as String?,
        version: json['version'] as int?,
        actions: (json['actions'] as List<dynamic>? ?? const [])
            .map((e) => ActionSummary.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}

/// drive-proxy DriveFile (via gateway `/api/v1/drive/files`). A folder is a
/// file whose mimeType is `application/vnd.google-apps.folder`.
class DriveFile {
  const DriveFile({
    required this.id,
    required this.name,
    required this.mimeType,
    required this.modifiedAt,
  });

  static const folderMime = 'application/vnd.google-apps.folder';

  final String id;
  final String name;
  final String mimeType;

  /// ISO8601 UTC
  final String modifiedAt;

  bool get isFolder => mimeType == folderMime;

  factory DriveFile.fromJson(Map<String, dynamic> json) => DriveFile(
        id: json['id'] as String,
        name: json['name'] as String,
        mimeType: json['mimeType'] as String,
        modifiedAt: json['modifiedAt'] as String,
      );
}

/// drive-proxy PaginatedDriveFiles.
class PaginatedDriveFiles {
  const PaginatedDriveFiles({required this.items, required this.nextCursor});

  final List<DriveFile> items;

  /// null = end of results.
  final String? nextCursor;

  factory PaginatedDriveFiles.fromJson(Map<String, dynamic> json) =>
      PaginatedDriveFiles(
        items: (json['items'] as List<dynamic>? ?? const [])
            .map((e) => DriveFile.fromJson(e as Map<String, dynamic>))
            .toList(),
        nextCursor: json['nextCursor'] as String?,
      );
}

/// Unified error envelope (`@dub/errors` ErrorResponse). Every non-2xx gateway
/// response uses this shape.
class DubApiException implements Exception {
  const DubApiException({
    required this.code,
    required this.message,
    required this.retryable,
    this.statusCode,
    this.requestId,
  });

  final String code;
  final String message;
  final bool retryable;
  final int? statusCode;
  final String? requestId;

  /// Builds from the wire `{ error: { code, message, retryable, requestId } }`.
  factory DubApiException.fromResponse(
    Object? body, {
    int? statusCode,
  }) {
    if (body is Map<String, dynamic> && body['error'] is Map) {
      final err = body['error'] as Map<String, dynamic>;
      return DubApiException(
        code: (err['code'] as String?) ?? 'UNKNOWN',
        message: (err['message'] as String?) ?? 'Unknown error',
        retryable: (err['retryable'] as bool?) ?? false,
        statusCode: statusCode,
        requestId: err['requestId'] as String?,
      );
    }
    return DubApiException(
      code: 'UNKNOWN',
      message: 'Unexpected response (HTTP ${statusCode ?? '?'}).',
      retryable: false,
      statusCode: statusCode,
    );
  }

  @override
  String toString() => 'DubApiException($code): $message';
}
