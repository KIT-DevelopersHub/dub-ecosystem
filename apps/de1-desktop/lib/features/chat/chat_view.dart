import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/models.dart';
import '../../state/auth.dart';
import 'chat_models.dart';
import 'chat_providers.dart';
import 'chat_realtime.dart';

/// Two-pane chat: channel list (left) + timeline & composer (right).
/// Web-parity slice — browse channels, read history, send (optimistic), and
/// receive live over the DO WebSocket.
class ChatView extends ConsumerWidget {
  const ChatView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final channelsAsync = ref.watch(chatChannelsProvider);
    final theme = Theme.of(context);

    // Auto-select the first channel once channels arrive.
    ref.listen(chatChannelsProvider, (_, next) {
      final list = next.asData?.value;
      if (list != null && list.isNotEmpty) {
        final sel = ref.read(selectedChannelIdProvider);
        if (sel == null || !list.any((c) => c.id == sel)) {
          ref.read(selectedChannelIdProvider.notifier).state = list.first.id;
        }
      }
    });

    return Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SizedBox(
          width: 260,
          child: _ChannelList(async: channelsAsync),
        ),
        VerticalDivider(width: 1, color: theme.colorScheme.outlineVariant),
        Expanded(
          child: channelsAsync.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (e, _) => _ErrorState(
              error: e,
              onRetry: () => ref.invalidate(chatChannelsProvider),
            ),
            data: (channels) {
              if (channels.isEmpty) {
                return const _EmptyChannels();
              }
              final selectedId = ref.watch(selectedChannelIdProvider);
              if (selectedId == null) {
                return const Center(child: CircularProgressIndicator());
              }
              final channel = channels.firstWhere(
                (c) => c.id == selectedId,
                orElse: () => channels.first,
              );
              return _ChannelPane(channel: channel);
            },
          ),
        ),
      ],
    );
  }
}

class _ChannelList extends ConsumerWidget {
  const _ChannelList({required this.async});
  final AsyncValue<List<ChatChannel>> async;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final selectedId = ref.watch(selectedChannelIdProvider);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 18, 12, 10),
          child: Row(
            children: [
              Text('チャンネル', style: theme.textTheme.titleMedium),
              const Spacer(),
              IconButton(
                tooltip: '再読み込み',
                iconSize: 18,
                icon: const Icon(Icons.refresh),
                onPressed: () => ref.invalidate(chatChannelsProvider),
              ),
            ],
          ),
        ),
        Expanded(
          child: async.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (_, __) => const SizedBox.shrink(),
            data: (channels) => ListView.builder(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              itemCount: channels.length,
              itemBuilder: (_, i) {
                final c = channels[i];
                final selected = c.id == selectedId;
                return Material(
                  color: selected
                      ? theme.colorScheme.primaryContainer
                      : Colors.transparent,
                  borderRadius: BorderRadius.circular(8),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(8),
                    onTap: () => ref
                        .read(selectedChannelIdProvider.notifier)
                        .state = c.id,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 10, vertical: 10),
                      child: Row(
                        children: [
                          Icon(Icons.tag,
                              size: 18,
                              color: selected
                                  ? theme.colorScheme.onPrimaryContainer
                                  : theme.colorScheme.outline),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              c.name,
                              overflow: TextOverflow.ellipsis,
                              style: theme.textTheme.bodyMedium?.copyWith(
                                fontWeight: selected
                                    ? FontWeight.w700
                                    : FontWeight.w500,
                                color: selected
                                    ? theme.colorScheme.onPrimaryContainer
                                    : null,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
        ),
      ],
    );
  }
}

class _ChannelPane extends ConsumerStatefulWidget {
  const _ChannelPane({required this.channel});
  final ChatChannel channel;

  @override
  ConsumerState<_ChannelPane> createState() => _ChannelPaneState();
}

class _ChannelPaneState extends ConsumerState<_ChannelPane> {
  final _composer = TextEditingController();
  final _scroll = ScrollController();

  @override
  void dispose() {
    _composer.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _send() {
    final text = _composer.text;
    if (text.trim().isEmpty) return;
    ref
        .read(chatTimelineProvider(widget.channel.id).notifier)
        .send(text);
    _composer.clear();
    _scrollToBottomSoon();
  }

  void _scrollToBottomSoon() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
        );
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final channelId = widget.channel.id;
    final state = ref.watch(chatTimelineProvider(channelId));
    final meId = ref.watch(authControllerProvider).me?.user.id;

    // Keep pinned to newest as messages arrive.
    ref.listen(chatTimelineProvider(channelId), (prev, next) {
      final grew = (prev?.messages.length ?? 0) < next.messages.length;
      if (grew) _scrollToBottomSoon();
    });

    return Column(
      children: [
        _ChannelHeader(channel: widget.channel, realtime: state.realtime),
        Divider(height: 1, color: theme.colorScheme.outlineVariant),
        Expanded(
          child: state.loading
              ? const Center(child: CircularProgressIndicator())
              : state.error != null
                  ? _ErrorState(
                      error: state.error!,
                      onRetry: () => ref.invalidate(
                          chatTimelineProvider(channelId)),
                    )
                  : state.messages.isEmpty
                      ? const _EmptyTimeline()
                      : ListView.builder(
                          controller: _scroll,
                          padding: const EdgeInsets.symmetric(
                              horizontal: 20, vertical: 14),
                          itemCount: state.messages.length,
                          itemBuilder: (_, i) => _MessageRow(
                            item: state.messages[i],
                            isMine:
                                state.messages[i].message.authorId == meId,
                            onRetry: (tag) => ref
                                .read(chatTimelineProvider(channelId)
                                    .notifier)
                                .retry(tag),
                          ),
                        ),
        ),
        _Composer(
          controller: _composer,
          onSend: _send,
          channelName: widget.channel.name,
        ),
      ],
    );
  }
}

class _ChannelHeader extends StatelessWidget {
  const _ChannelHeader({required this.channel, required this.realtime});
  final ChatChannel channel;
  final RealtimeStatus realtime;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 14, 20, 12),
      child: Row(
        children: [
          Icon(Icons.tag, size: 20, color: theme.colorScheme.outline),
          const SizedBox(width: 6),
          Text(channel.name, style: theme.textTheme.titleMedium),
          const Spacer(),
          _RealtimeBadge(status: realtime),
        ],
      ),
    );
  }
}

class _RealtimeBadge extends StatelessWidget {
  const _RealtimeBadge({required this.status});
  final RealtimeStatus status;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final (color, label) = switch (status) {
      RealtimeStatus.connected => (Colors.green, 'リアルタイム接続中'),
      RealtimeStatus.connecting => (theme.colorScheme.outline, '接続中…'),
      RealtimeStatus.disconnected => (theme.colorScheme.error, '再接続中…'),
    };
    return Row(
      children: [
        Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: 6),
        Text(label,
            style: theme.textTheme.labelSmall
                ?.copyWith(color: theme.colorScheme.outline)),
      ],
    );
  }
}

class _MessageRow extends StatelessWidget {
  const _MessageRow({
    required this.item,
    required this.isMine,
    required this.onRetry,
  });
  final TimelineMessage item;
  final bool isMine;
  final void Function(String clientTag) onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final msg = item.message;
    final bubbleColor = isMine
        ? theme.colorScheme.primary
        : theme.colorScheme.surfaceContainerHighest;
    final textColor =
        isMine ? theme.colorScheme.onPrimary : theme.colorScheme.onSurface;

    final bubble = Opacity(
      opacity: item.pending ? 0.6 : 1,
      child: Container(
        constraints: const BoxConstraints(maxWidth: 520),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: item.failed
              ? theme.colorScheme.errorContainer
              : bubbleColor,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (!isMine)
              Padding(
                padding: const EdgeInsets.only(bottom: 3),
                child: Text(
                  msg.authorId,
                  style: theme.textTheme.labelSmall
                      ?.copyWith(color: theme.colorScheme.outline),
                ),
              ),
            Text(
              msg.body,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: item.failed
                    ? theme.colorScheme.onErrorContainer
                    : textColor,
              ),
            ),
            const SizedBox(height: 3),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  _timeLabel(msg.createdAt),
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: (isMine && !item.failed)
                        ? theme.colorScheme.onPrimary.withValues(alpha: 0.8)
                        : theme.colorScheme.outline,
                  ),
                ),
                if (item.pending) ...[
                  const SizedBox(width: 6),
                  const SizedBox(
                    width: 10,
                    height: 10,
                    child: CircularProgressIndicator(strokeWidth: 1.6),
                  ),
                ],
                if (item.failed) ...[
                  const SizedBox(width: 8),
                  InkWell(
                    onTap: () {
                      final tag = item.clientTag;
                      if (tag != null) onRetry(tag);
                    },
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.error_outline,
                            size: 13, color: theme.colorScheme.error),
                        const SizedBox(width: 2),
                        Text('再送',
                            style: theme.textTheme.labelSmall?.copyWith(
                                color: theme.colorScheme.error)),
                      ],
                    ),
                  ),
                ],
              ],
            ),
          ],
        ),
      ),
    );

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Align(
        alignment: isMine ? Alignment.centerRight : Alignment.centerLeft,
        child: bubble,
      ),
    );
  }

  static String _timeLabel(String iso) {
    final dt = DateTime.tryParse(iso);
    if (dt == null) return '';
    final local = dt.toLocal();
    String two(int n) => n.toString().padLeft(2, '0');
    return '${two(local.hour)}:${two(local.minute)}';
  }
}

class _Composer extends StatelessWidget {
  const _Composer({
    required this.controller,
    required this.onSend,
    required this.channelName,
  });
  final TextEditingController controller;
  final VoidCallback onSend;
  final String channelName;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 14),
      decoration: BoxDecoration(
        border: Border(
          top: BorderSide(color: theme.colorScheme.outlineVariant),
        ),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(
            child: CallbackShortcuts(
              bindings: {
                const SingleActivator(LogicalKeyboardKey.enter): onSend,
              },
              child: TextField(
                controller: controller,
                minLines: 1,
                maxLines: 6,
                textInputAction: TextInputAction.send,
                onSubmitted: (_) => onSend(),
                decoration: InputDecoration(
                  hintText: '#$channelName へメッセージを送信',
                  filled: true,
                  fillColor: theme.colorScheme.surface,
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(12),
                    borderSide:
                        BorderSide(color: theme.colorScheme.outlineVariant),
                  ),
                  contentPadding: const EdgeInsets.symmetric(
                      horizontal: 14, vertical: 12),
                ),
              ),
            ),
          ),
          const SizedBox(width: 8),
          FilledButton(
            onPressed: onSend,
            style: FilledButton.styleFrom(
              padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 16),
            ),
            child: const Icon(Icons.send, size: 18),
          ),
        ],
      ),
    );
  }
}

class _EmptyChannels extends StatelessWidget {
  const _EmptyChannels();
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.forum_outlined, size: 48, color: theme.colorScheme.outline),
          const SizedBox(height: 8),
          const Text('チャンネルがありません'),
        ],
      ),
    );
  }
}

class _EmptyTimeline extends StatelessWidget {
  const _EmptyTimeline();
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.chat_bubble_outline,
              size: 44, color: theme.colorScheme.outline),
          const SizedBox(height: 8),
          Text('まだメッセージはありません',
              style: theme.textTheme.bodyMedium
                  ?.copyWith(color: theme.colorScheme.outline)),
        ],
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.error, required this.onRetry});
  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final message =
        error is DubApiException ? (error as DubApiException).message : '$error';
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.error_outline, size: 44, color: theme.colorScheme.error),
          const SizedBox(height: 8),
          Text('読み込みに失敗しました', style: theme.textTheme.titleMedium),
          const SizedBox(height: 4),
          Text(message,
              style: theme.textTheme.bodySmall
                  ?.copyWith(color: theme.colorScheme.outline)),
          const SizedBox(height: 12),
          FilledButton.tonal(onPressed: onRetry, child: const Text('再試行')),
        ],
      ),
    );
  }
}
