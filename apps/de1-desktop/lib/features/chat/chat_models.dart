/// Chat-feature wire models. Dart mirrors of the frozen `@dub/types` chat
/// contract (`docs/openapi/chat-service.yaml`). Feature-owned.
library;

/// chat-service ChatChannel.
class ChatChannel {
  const ChatChannel({
    required this.id,
    required this.name,
    required this.createdAt,
  });

  final String id;
  final String name;

  /// ISO8601 UTC
  final String createdAt;

  factory ChatChannel.fromJson(Map<String, dynamic> json) => ChatChannel(
        id: json['id'] as String,
        name: json['name'] as String,
        createdAt: json['createdAt'] as String? ?? '',
      );
}

/// chat-service ChatMessage.
class ChatMessage {
  const ChatMessage({
    required this.id,
    required this.channelId,
    required this.authorId,
    required this.body,
    required this.createdAt,
  });

  final String id;
  final String channelId;
  final String authorId;
  final String body;

  /// ISO8601 UTC
  final String createdAt;

  factory ChatMessage.fromJson(Map<String, dynamic> json) => ChatMessage(
        id: json['id'] as String,
        channelId: json['channelId'] as String,
        authorId: json['authorId'] as String,
        body: json['body'] as String,
        createdAt: json['createdAt'] as String? ?? '',
      );
}

/// chat-service ChannelList.
class ChannelList {
  const ChannelList({required this.items});

  final List<ChatChannel> items;

  factory ChannelList.fromJson(Map<String, dynamic> json) => ChannelList(
        items: (json['items'] as List<dynamic>? ?? const [])
            .map((e) => ChatChannel.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}

/// chat-service MessagePage (cursor pagination).
class MessagePage {
  const MessagePage({required this.items, required this.nextCursor});

  final List<ChatMessage> items;

  /// null = end of results (older history exhausted).
  final String? nextCursor;

  factory MessagePage.fromJson(Map<String, dynamic> json) => MessagePage(
        items: (json['items'] as List<dynamic>? ?? const [])
            .map((e) => ChatMessage.fromJson(e as Map<String, dynamic>))
            .toList(),
        nextCursor: json['nextCursor'] as String?,
      );
}

/// chat-service WsTicketResponse. Short-lived HMAC ticket + absolute DO URL.
/// The WebSocket connects DIRECTLY to the ChatRoom Durable Object (the gateway
/// rejects WS upgrades), presenting the ticket as a `?ticket=` query param.
class WsTicket {
  const WsTicket({
    required this.ticket,
    required this.doUrl,
    required this.expiresAt,
  });

  final String ticket;

  /// Absolute ws(s):// URL ending in `/ws/<channelId>`.
  final String doUrl;

  /// ISO8601 UTC
  final String expiresAt;

  /// The full connect URL: `doUrl?ticket=<ticket>`.
  Uri connectUri() {
    final base = Uri.parse(doUrl);
    return base.replace(queryParameters: {
      ...base.queryParameters,
      'ticket': ticket,
    });
  }

  factory WsTicket.fromJson(Map<String, dynamic> json) => WsTicket(
        ticket: json['ticket'] as String,
        doUrl: json['doUrl'] as String,
        expiresAt: json['expiresAt'] as String? ?? '',
      );
}

/// Realtime fan-out event (frozen `@dub/types` `ChatRealtimeEvent`), received
/// over the DO WebSocket. Modeled as a tagged struct: `kind` discriminates.
class ChatRealtimeEvent {
  const ChatRealtimeEvent({
    required this.kind,
    required this.channelId,
    this.messageId,
    this.authorId,
    this.body,
    this.at,
    this.threadRootId,
    this.mode,
  });

  final String kind;
  final String channelId;
  final String? messageId;
  final String? authorId;
  final String? body;

  /// ISO8601 UTC
  final String? at;
  final String? threadRootId;

  /// message.deleted resolution: 'hard' | 'tombstone'.
  final String? mode;

  bool get isMessageCreated => kind == 'message.created';
  bool get isMessageDeleted => kind == 'message.deleted';

  /// A top-level (non-thread) new message that belongs in the main timeline.
  bool get isTimelineMessage => isMessageCreated && threadRootId == null;

  ChatMessage toMessage() => ChatMessage(
        id: messageId ?? '',
        channelId: channelId,
        authorId: authorId ?? '',
        body: body ?? '',
        createdAt: at ?? '',
      );

  factory ChatRealtimeEvent.fromJson(Map<String, dynamic> json) =>
      ChatRealtimeEvent(
        kind: json['kind'] as String,
        channelId: json['channelId'] as String,
        messageId: json['messageId'] as String?,
        authorId: json['authorId'] as String?,
        body: json['body'] as String?,
        at: json['at'] as String?,
        threadRootId: json['threadRootId'] as String?,
        mode: json['mode'] as String?,
      );
}
