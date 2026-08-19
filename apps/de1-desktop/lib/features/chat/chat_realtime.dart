import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

import 'chat_api.dart';
import 'chat_models.dart';

enum RealtimeStatus { connecting, connected, disconnected }

/// Manages one DO-direct WebSocket for a channel (ADR-0002): mint a ws-ticket,
/// connect straight to the ChatRoom Durable Object (gateway-bypassing), decode
/// [ChatRealtimeEvent] frames, heartbeat-ping, and reconnect with backoff.
///
/// A fresh ticket is minted on every (re)connect because tickets are short-lived.
class ChatSocket {
  ChatSocket({
    required this.channelId,
    required this.api,
    required this.onEvent,
    required this.onStatus,
  });

  final String channelId;
  final ChatApi api;
  final void Function(ChatRealtimeEvent) onEvent;
  final void Function(RealtimeStatus) onStatus;

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _sub;
  Timer? _ping;
  Timer? _reconnect;
  int _attempt = 0;
  bool _closed = false;

  Future<void> start() => _connect();

  Future<void> _connect() async {
    if (_closed) return;
    onStatus(RealtimeStatus.connecting);
    try {
      final ticket = await api.issueWsTicket(channelId);
      final channel = WebSocketChannel.connect(ticket.connectUri());
      _channel = channel;
      await channel.ready; // completes on open, throws on failure
      if (_closed) {
        await channel.sink.close();
        return;
      }
      _attempt = 0;
      onStatus(RealtimeStatus.connected);
      _sub = channel.stream.listen(
        _onData,
        onDone: _onDone,
        onError: (Object _) => _onDone(),
        cancelOnError: true,
      );
      // Liveness heartbeat; the DO replies "pong".
      _ping = Timer.periodic(const Duration(seconds: 30), (_) {
        try {
          channel.sink.add('ping');
        } catch (_) {
          // sink gone; the done/error path handles reconnect.
        }
      });
    } catch (_) {
      _scheduleReconnect();
    }
  }

  void _onData(dynamic data) {
    if (data is! String || data == 'pong') return;
    try {
      final json = jsonDecode(data) as Map<String, dynamic>;
      onEvent(ChatRealtimeEvent.fromJson(json));
    } catch (_) {
      // ignore malformed / unknown frame
    }
  }

  void _onDone() {
    _ping?.cancel();
    _sub?.cancel();
    if (_closed) return;
    onStatus(RealtimeStatus.disconnected);
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_closed) return;
    _attempt++;
    final secs = (1 << _attempt.clamp(1, 4)); // 2, 4, 8, 16, 16…
    _reconnect?.cancel();
    _reconnect = Timer(Duration(seconds: secs), _connect);
  }

  Future<void> dispose() async {
    _closed = true;
    _ping?.cancel();
    _reconnect?.cancel();
    await _sub?.cancel();
    await _channel?.sink.close();
  }
}
