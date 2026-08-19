import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../state/auth.dart';
import 'chat_api.dart';
import 'chat_models.dart';
import 'chat_realtime.dart';

/// Channels the caller can see. Refetches when the shared client is (re)created.
final chatChannelsProvider = FutureProvider<List<ChatChannel>>((ref) async {
  final api = await ref.watch(chatApiProvider.future);
  return api.listChannels();
});

/// The currently open channel id (null = none selected yet).
final selectedChannelIdProvider = StateProvider<String?>((_) => null);

/// Per-channel message timeline (loads history, holds the live WS, sends
/// optimistically). autoDispose so switching channels tears down the old WS.
final chatTimelineProvider = StateNotifierProvider.autoDispose
    .family<ChatTimelineController, ChatTimelineState, String>(
  (ref, channelId) => ChatTimelineController(ref, channelId),
);

/// Delivery status of a message in the timeline.
enum MsgStatus { sent, sending, failed }

/// A message plus its optimistic-UI status. `clientTag` reconciles an optimistic
/// row with its server/WS counterpart.
class TimelineMessage {
  const TimelineMessage(
    this.message, {
    this.status = MsgStatus.sent,
    this.clientTag,
  });

  final ChatMessage message;
  final MsgStatus status;
  final String? clientTag;

  bool get pending => status == MsgStatus.sending;
  bool get failed => status == MsgStatus.failed;

  TimelineMessage copyWith({ChatMessage? message, MsgStatus? status}) =>
      TimelineMessage(
        message ?? this.message,
        status: status ?? this.status,
        clientTag: clientTag,
      );
}

class ChatTimelineState {
  const ChatTimelineState({
    required this.loading,
    required this.messages,
    required this.realtime,
    this.error,
  });

  const ChatTimelineState.loading()
      : loading = true,
        messages = const [],
        realtime = RealtimeStatus.connecting,
        error = null;

  final bool loading;
  final List<TimelineMessage> messages;
  final RealtimeStatus realtime;
  final Object? error;

  ChatTimelineState copyWith({
    bool? loading,
    List<TimelineMessage>? messages,
    RealtimeStatus? realtime,
    Object? error,
    bool clearError = false,
  }) =>
      ChatTimelineState(
        loading: loading ?? this.loading,
        messages: messages ?? this.messages,
        realtime: realtime ?? this.realtime,
        error: clearError ? null : (error ?? this.error),
      );
}

class ChatTimelineController extends StateNotifier<ChatTimelineState> {
  ChatTimelineController(this._ref, this.channelId)
      : super(const ChatTimelineState.loading()) {
    _init();
  }

  final Ref _ref;
  final String channelId;

  ChatApi? _api;
  ChatSocket? _socket;
  final Set<String> _seen = <String>{};
  int _localSeq = 0;

  String? get _meId => _ref.read(authControllerProvider).me?.user.id;

  Future<void> _init() async {
    try {
      final api = await _ref.read(chatApiProvider.future);
      _api = api;
      final page = await api.listMessages(channelId, limit: 50);
      final sorted = [...page.items]
        ..sort((a, b) => a.createdAt.compareTo(b.createdAt));
      for (final m in sorted) {
        _seen.add(m.id);
      }
      if (!mounted) return;
      state = state.copyWith(
        loading: false,
        messages: sorted.map((m) => TimelineMessage(m)).toList(),
      );
      _markRead();
      _startSocket(api);
    } catch (e) {
      if (!mounted) return;
      state = state.copyWith(loading: false, error: e);
    }
  }

  void _startSocket(ChatApi api) {
    _socket = ChatSocket(
      channelId: channelId,
      api: api,
      onEvent: _onEvent,
      onStatus: (s) {
        if (mounted) state = state.copyWith(realtime: s);
      },
    );
    _socket!.start();
  }

  void _onEvent(ChatRealtimeEvent e) {
    if (!mounted || e.channelId != channelId) return;

    if (e.isTimelineMessage) {
      final id = e.messageId;
      if (id == null || _seen.contains(id)) return;

      // Reconcile our own optimistic row if the WS frame beat the POST response.
      final meId = _meId;
      if (meId != null && e.authorId == meId) {
        final idx = state.messages.indexWhere(
          (t) => t.pending && t.message.body == e.body,
        );
        if (idx != -1) {
          _seen.add(id);
          final list = [...state.messages];
          list[idx] = TimelineMessage(e.toMessage());
          state = state.copyWith(messages: list);
          return;
        }
      }

      _seen.add(id);
      state = state.copyWith(
        messages: [...state.messages, TimelineMessage(e.toMessage())],
      );
      _markRead();
    } else if (e.isMessageDeleted) {
      final id = e.messageId;
      if (id == null) return;
      _seen.remove(id);
      state = state.copyWith(
        messages:
            state.messages.where((t) => t.message.id != id).toList(),
      );
    }
  }

  /// Optimistic send: show the message immediately, then reconcile with the
  /// server's persisted row (or mark failed for retry).
  Future<void> send(String body) async {
    final text = body.trim();
    final api = _api;
    if (text.isEmpty || api == null) return;

    final meId = _meId ?? 'me';
    final tag = 'local_${_localSeq++}_${DateTime.now().microsecondsSinceEpoch}';
    final optimistic = TimelineMessage(
      ChatMessage(
        id: tag,
        channelId: channelId,
        authorId: meId,
        body: text,
        createdAt: DateTime.now().toUtc().toIso8601String(),
      ),
      status: MsgStatus.sending,
      clientTag: tag,
    );
    state = state.copyWith(messages: [...state.messages, optimistic]);

    try {
      final saved = await api.postMessage(channelId, text);
      if (!mounted) return;
      _seen.add(saved.id);
      final list = [...state.messages];
      final idx = list.indexWhere((t) => t.clientTag == tag);
      if (idx != -1) {
        final alreadyLive =
            list.any((t) => t.clientTag == null && t.message.id == saved.id);
        if (alreadyLive) {
          list.removeAt(idx); // WS already delivered the real row
        } else {
          list[idx] = TimelineMessage(saved);
        }
        state = state.copyWith(messages: list);
      }
      _markRead();
    } catch (_) {
      if (!mounted) return;
      final list = [...state.messages];
      final idx = list.indexWhere((t) => t.clientTag == tag);
      if (idx != -1) {
        list[idx] = list[idx].copyWith(status: MsgStatus.failed);
        state = state.copyWith(messages: list);
      }
    }
  }

  /// Retry a failed optimistic message.
  Future<void> retry(String clientTag) async {
    final idx = state.messages
        .indexWhere((t) => t.clientTag == clientTag && t.failed);
    if (idx == -1) return;
    final failed = state.messages[idx];
    state = state.copyWith(
      messages: [...state.messages]..removeAt(idx),
    );
    await send(failed.message.body);
  }

  void _markRead() {
    final api = _api;
    if (api == null) return;
    String? lastId;
    for (final t in state.messages) {
      if (t.status == MsgStatus.sent) lastId = t.message.id;
    }
    if (lastId == null) return;
    api.updateReadState(channelId, lastId).ignore();
  }

  @override
  void dispose() {
    _socket?.dispose();
    super.dispose();
  }
}
