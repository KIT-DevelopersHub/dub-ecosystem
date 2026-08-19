import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/models.dart' show DubApiException;
import '../api/mail_models.dart';
import '../state/mail.dart';

/// Mail feature: a Gmail-style three-pane layout — folder rail, message list,
/// and a reading pane (thread conversation). Reads are live from the shared
/// mail-gateway; 既読 and 下書き are client-side (see `state/mail.dart`).
/// Compose stops at "save draft" (no send) per the slice scope.
class MailView extends ConsumerWidget {
  const MailView({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(width: 180, child: _FolderRail()),
        VerticalDivider(width: 1, color: theme.colorScheme.outlineVariant),
        const SizedBox(width: 320, child: _MessageList()),
        VerticalDivider(width: 1, color: theme.colorScheme.outlineVariant),
        const Expanded(child: _ReadingPane()),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Folder rail
// ---------------------------------------------------------------------------

class _FolderRail extends ConsumerWidget {
  const _FolderRail();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final selected = ref.watch(selectedFolderProvider);
    final theme = Theme.of(context);
    final draftCount = ref.watch(draftsProvider).length;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 20, 16, 12),
          child: FilledButton.icon(
            key: const Key('mail-compose-button'),
            onPressed: () => showComposeDialog(context, ref),
            icon: const Icon(Icons.edit_outlined, size: 18),
            label: const Text('作成'),
          ),
        ),
        for (final folder in MailFolder.values)
          _FolderTile(
            folder: folder,
            selected: folder == selected,
            badge: folder == MailFolder.drafts && draftCount > 0
                ? draftCount
                : null,
            onTap: () {
              ref.read(selectedFolderProvider.notifier).state = folder;
              ref.read(selectedMailProvider.notifier).state = null;
              ref.read(selectedDraftProvider.notifier).state = null;
            },
          ),
        const Spacer(),
        Padding(
          padding: const EdgeInsets.all(16),
          child: Text(
            '共有ゲートウェイに接続',
            style: theme.textTheme.labelSmall
                ?.copyWith(color: theme.colorScheme.outline),
          ),
        ),
      ],
    );
  }
}

class _FolderTile extends StatelessWidget {
  const _FolderTile({
    required this.folder,
    required this.selected,
    required this.onTap,
    this.badge,
  });

  final MailFolder folder;
  final bool selected;
  final VoidCallback onTap;
  final int? badge;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      child: Material(
        color: selected
            ? theme.colorScheme.secondaryContainer
            : Colors.transparent,
        borderRadius: BorderRadius.circular(10),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(10),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Row(
              children: [
                Icon(folder.icon,
                    size: 20,
                    color: selected
                        ? theme.colorScheme.onSecondaryContainer
                        : theme.colorScheme.outline),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    folder.label,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      fontWeight:
                          selected ? FontWeight.w700 : FontWeight.w500,
                    ),
                  ),
                ),
                if (badge != null)
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
                    decoration: BoxDecoration(
                      color: theme.colorScheme.primary,
                      borderRadius: BorderRadius.circular(9),
                    ),
                    child: Text(
                      '$badge',
                      style: theme.textTheme.labelSmall
                          ?.copyWith(color: theme.colorScheme.onPrimary),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Message list (per folder)
// ---------------------------------------------------------------------------

class _MessageList extends ConsumerWidget {
  const _MessageList();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final folder = ref.watch(selectedFolderProvider);
    final theme = Theme.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 18, 12, 10),
          child: Row(
            children: [
              Text(folder.label, style: theme.textTheme.titleMedium),
              const Spacer(),
              if (folder == MailFolder.inbox)
                IconButton(
                  tooltip: '再読み込み',
                  icon: const Icon(Icons.refresh, size: 20),
                  onPressed: () => ref.invalidate(mailMessagesProvider),
                ),
            ],
          ),
        ),
        Divider(height: 1, color: theme.colorScheme.outlineVariant),
        Expanded(
          child: folder == MailFolder.inbox
              ? const _InboxList()
              : const _DraftList(),
        ),
      ],
    );
  }
}

class _InboxList extends ConsumerWidget {
  const _InboxList();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(mailMessagesProvider);
    return async.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => _ErrorState(
        error: e,
        onRetry: () => ref.invalidate(mailMessagesProvider),
      ),
      data: (page) => page.items.isEmpty
          ? const _EmptyState(
              icon: Icons.inbox_outlined, label: 'メールはありません')
          : ListView.separated(
              itemCount: page.items.length,
              separatorBuilder: (_, __) =>
                  const Divider(height: 1, indent: 16, endIndent: 16),
              itemBuilder: (_, i) => _MessageRow(message: page.items[i]),
            ),
    );
  }
}

class _MessageRow extends ConsumerWidget {
  const _MessageRow({required this.message});
  final MailMessage message;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final isRead = ref.watch(readMailProvider).contains(message.id);
    final isSelected =
        ref.watch(selectedMailProvider)?.id == message.id;

    return Material(
      color: isSelected
          ? theme.colorScheme.secondaryContainer.withValues(alpha: 0.5)
          : Colors.transparent,
      child: InkWell(
        onTap: () {
          // Optimistic: mark read instantly (no server read-state in P0).
          ref.read(readMailProvider.notifier).markRead(message.id);
          ref.read(selectedMailProvider.notifier).state = message;
          ref.read(selectedDraftProvider.notifier).state = null;
        },
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 8,
                height: 8,
                margin: const EdgeInsets.only(top: 6, right: 10),
                decoration: BoxDecoration(
                  color:
                      isRead ? Colors.transparent : theme.colorScheme.primary,
                  shape: BoxShape.circle,
                ),
              ),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            message.from.shortLabel,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.bodyMedium?.copyWith(
                              fontWeight:
                                  isRead ? FontWeight.w500 : FontWeight.w700,
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text(
                          _shortTime(message.receivedAt),
                          style: theme.textTheme.labelSmall
                              ?.copyWith(color: theme.colorScheme.outline),
                        ),
                      ],
                    ),
                    const SizedBox(height: 2),
                    Text(
                      message.subject,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        fontWeight:
                            isRead ? FontWeight.w400 : FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      message.snippet,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodySmall
                          ?.copyWith(color: theme.colorScheme.outline),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _DraftList extends ConsumerWidget {
  const _DraftList();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final drafts = ref.watch(draftsProvider);
    final theme = Theme.of(context);
    if (drafts.isEmpty) {
      return const _EmptyState(
          icon: Icons.drafts_outlined, label: '下書きはありません');
    }
    return ListView.separated(
      itemCount: drafts.length,
      separatorBuilder: (_, __) =>
          const Divider(height: 1, indent: 16, endIndent: 16),
      itemBuilder: (_, i) {
        final draft = drafts[i];
        return Material(
          color: Colors.transparent,
          child: InkWell(
            onTap: () => showComposeDialog(context, ref, draft: draft),
            child: Padding(
              padding:
                  const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    draft.subject.isEmpty ? '(件名なし)' : draft.subject,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodyMedium
                        ?.copyWith(fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    draft.to.isEmpty ? '宛先未設定' : 'To: ${draft.to}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodySmall
                        ?.copyWith(color: theme.colorScheme.outline),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Reading pane (thread conversation)
// ---------------------------------------------------------------------------

class _ReadingPane extends ConsumerWidget {
  const _ReadingPane();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final selected = ref.watch(selectedMailProvider);
    if (selected == null) {
      return const _EmptyState(
        icon: Icons.mail_outline,
        label: 'メールを選択してください',
      );
    }
    return _ThreadView(seed: selected);
  }
}

class _ThreadView extends ConsumerWidget {
  const _ThreadView({required this.seed});

  /// The message that was tapped in the list — used for the header and as a
  /// fallback if the thread fetch fails.
  final MailMessage seed;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final async = ref.watch(mailThreadProvider(seed.threadId));

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(28, 22, 28, 14),
          child: Text(
            seed.subject.isEmpty ? '(件名なし)' : seed.subject,
            style: theme.textTheme.headlineSmall,
          ),
        ),
        Divider(height: 1, color: theme.colorScheme.outlineVariant),
        Expanded(
          child: async.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            // Fall back to the single seed message if the thread fetch fails.
            error: (_, __) => ListView(
              padding: const EdgeInsets.all(24),
              children: [_MessageCard(message: seed)],
            ),
            data: (thread) {
              final messages =
                  thread.messages.isEmpty ? [seed] : thread.messages;
              return ListView.separated(
                padding: const EdgeInsets.all(24),
                itemCount: messages.length,
                separatorBuilder: (_, __) => const SizedBox(height: 16),
                itemBuilder: (_, i) => _MessageCard(message: messages[i]),
              );
            },
          ),
        ),
      ],
    );
  }
}

class _MessageCard extends StatelessWidget {
  const _MessageCard({required this.message});
  final MailMessage message;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final toLine = message.to.map((a) => a.display).join(', ');
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: theme.colorScheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              CircleAvatar(
                radius: 18,
                backgroundColor: theme.colorScheme.primaryContainer,
                child: Text(
                  message.from.shortLabel.characters.first.toUpperCase(),
                  style: TextStyle(
                      color: theme.colorScheme.onPrimaryContainer),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(message.from.display,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.titleSmall),
                    if (toLine.isNotEmpty)
                      Text('To: $toLine',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.bodySmall?.copyWith(
                              color: theme.colorScheme.outline)),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Text(
                _shortTime(message.receivedAt),
                style: theme.textTheme.labelSmall
                    ?.copyWith(color: theme.colorScheme.outline),
              ),
            ],
          ),
          const SizedBox(height: 14),
          SelectableText(
            message.snippet,
            style: theme.textTheme.bodyMedium?.copyWith(height: 1.5),
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Compose (save-draft only; no send in this slice)
// ---------------------------------------------------------------------------

/// Opens the compose dialog for a new message, or to edit an existing [draft].
/// Saving is optimistic: the drafts list updates instantly and the view
/// switches to the 下書き folder.
Future<void> showComposeDialog(
  BuildContext context,
  WidgetRef ref, {
  MailDraft? draft,
}) {
  return showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (_) => _ComposeDialog(existing: draft),
  );
}

class _ComposeDialog extends ConsumerStatefulWidget {
  const _ComposeDialog({this.existing});
  final MailDraft? existing;

  @override
  ConsumerState<_ComposeDialog> createState() => _ComposeDialogState();
}

class _ComposeDialogState extends ConsumerState<_ComposeDialog> {
  late final TextEditingController _to;
  late final TextEditingController _subject;
  late final TextEditingController _body;

  @override
  void initState() {
    super.initState();
    _to = TextEditingController(text: widget.existing?.to ?? '');
    _subject = TextEditingController(text: widget.existing?.subject ?? '');
    _body = TextEditingController(text: widget.existing?.body ?? '');
  }

  @override
  void dispose() {
    _to.dispose();
    _subject.dispose();
    _body.dispose();
    super.dispose();
  }

  void _saveDraft() {
    final notifier = ref.read(draftsProvider.notifier);
    final existing = widget.existing;
    if (existing == null) {
      notifier.create(
        to: _to.text,
        subject: _subject.text,
        body: _body.text,
      );
    } else {
      notifier.update(existing.copyWith(
        to: _to.text,
        subject: _subject.text,
        body: _body.text,
      ));
    }
    // Surface the newly-saved draft.
    ref.read(selectedFolderProvider.notifier).state = MailFolder.drafts;
    ref.read(selectedMailProvider.notifier).state = null;
    Navigator.of(context).pop();
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('下書きを保存しました')),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Dialog(
      shape:
          RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 620),
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  const Icon(Icons.edit_outlined, size: 20),
                  const SizedBox(width: 10),
                  Text(widget.existing == null ? '新規メッセージ' : '下書きを編集',
                      style: theme.textTheme.titleMedium),
                  const Spacer(),
                  IconButton(
                    tooltip: '閉じる',
                    icon: const Icon(Icons.close),
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              TextField(
                key: const Key('mail-compose-to'),
                controller: _to,
                decoration: const InputDecoration(
                  labelText: '宛先',
                  hintText: 'name@developershub.jp',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                key: const Key('mail-compose-subject'),
                controller: _subject,
                decoration: const InputDecoration(
                  labelText: '件名',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                key: const Key('mail-compose-body'),
                controller: _body,
                minLines: 6,
                maxLines: 12,
                decoration: const InputDecoration(
                  labelText: '本文',
                  alignLabelWithHint: true,
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 16),
              Row(
                children: [
                  Text(
                    '送信はまだできません（下書き保存のみ）',
                    style: theme.textTheme.bodySmall
                        ?.copyWith(color: theme.colorScheme.outline),
                  ),
                  const Spacer(),
                  TextButton(
                    onPressed: () => Navigator.of(context).pop(),
                    child: const Text('キャンセル'),
                  ),
                  const SizedBox(width: 8),
                  FilledButton.icon(
                    key: const Key('mail-compose-save'),
                    onPressed: _saveDraft,
                    icon: const Icon(Icons.save_outlined, size: 18),
                    label: const Text('下書き保存'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/// Formats an ISO8601 timestamp to a compact local "MM/dd HH:mm". Falls back to
/// the raw string if it can't be parsed.
String _shortTime(String iso) {
  final dt = DateTime.tryParse(iso);
  if (dt == null) return iso;
  final l = dt.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${two(l.month)}/${two(l.day)} ${two(l.hour)}:${two(l.minute)}';
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.icon, required this.label});
  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 48, color: theme.colorScheme.outline),
          const SizedBox(height: 8),
          Text(label,
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
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24),
            child: Text(message,
                textAlign: TextAlign.center,
                style: theme.textTheme.bodySmall
                    ?.copyWith(color: theme.colorScheme.outline)),
          ),
          const SizedBox(height: 12),
          FilledButton.tonal(onPressed: onRetry, child: const Text('再試行')),
        ],
      ),
    );
  }
}
