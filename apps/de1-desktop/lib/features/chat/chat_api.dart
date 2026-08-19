import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import 'chat_models.dart';

/// Chat feature API. Mirrors `/api/v1/chat/*` (chat-service). Wraps the shared
/// [ApiClient]; the feature owns its endpoints.
class ChatApi {
  ChatApi(this._client);

  final ApiClient _client;

  /// GET /chat/channels — channels the caller can see.
  Future<List<ChatChannel>> listChannels({String? eventId}) async {
    final json = await _client.getJson(
      '/chat/channels',
      query: {if (eventId != null) 'eventId': eventId},
    );
    return ChannelList.fromJson(json).items;
  }

  /// GET /chat/messages?channelId=… — a page of messages in a channel.
  Future<MessagePage> listMessages(
    String channelId, {
    String? cursor,
    int limit = 50,
  }) async {
    final json = await _client.getJson(
      '/chat/messages',
      query: {
        'channelId': channelId,
        'limit': limit,
        if (cursor != null) 'cursor': cursor,
      },
    );
    return MessagePage.fromJson(json);
  }

  /// POST /chat/messages — post a message. Returns the persisted message.
  Future<ChatMessage> postMessage(String channelId, String body) async {
    final json = await _client.postJson(
      '/chat/messages',
      body: {'channelId': channelId, 'body': body},
    );
    return ChatMessage.fromJson(json);
  }

  /// POST /chat/channels/{id}/read — advance the caller's read cursor.
  Future<void> updateReadState(String channelId, String lastReadMessageId) async {
    await _client.postJson(
      '/chat/channels/$channelId/read',
      body: {'lastReadMessageId': lastReadMessageId},
    );
  }

  /// GET /chat/channels/{id}/ws-ticket — mint a DO-direct WebSocket ticket.
  Future<WsTicket> issueWsTicket(String channelId) async {
    final json = await _client.getJson('/chat/channels/$channelId/ws-ticket');
    return WsTicket.fromJson(json);
  }
}

final chatApiProvider = FutureProvider<ChatApi>((ref) async {
  final client = await ref.watch(apiClientProvider.future);
  return ChatApi(client);
});
