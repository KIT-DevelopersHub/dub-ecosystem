import 'package:flutter/material.dart';

import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import 'notifications_repository.dart';

/// The notification inbox — the caller's items from
/// `GET /api/v1/notifications/inbox` (self-scoped, notif:inbox:self).
class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key, required this.repository});

  final NotificationsRepository repository;

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  bool _unreadOnly = false;
  late Future<List<InboxNotification>> _future = _load();

  Future<List<InboxNotification>> _load() =>
      widget.repository.fetchInbox(unreadOnly: _unreadOnly);

  void _reload() => setState(() => _future = _load());

  @override
  Widget build(BuildContext context) {
    final c = AppTheme.of(context);
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 20, 24, 8),
          child: Row(
            children: [
              Text('通知', style: Theme.of(context).textTheme.headlineSmall),
              const Spacer(),
              FilterChip(
                label: const Text('未読のみ'),
                selected: _unreadOnly,
                onSelected: (v) {
                  setState(() => _unreadOnly = v);
                  _reload();
                },
              ),
              const SizedBox(width: 8),
              IconButton(
                onPressed: _reload,
                icon: const Icon(Icons.refresh),
                tooltip: '再読み込み',
              ),
            ],
          ),
        ),
        Expanded(
          child: AsyncView<List<InboxNotification>>(
            future: _future,
            onRetry: _reload,
            emptyCheck: (list) => list.isEmpty,
            emptyLabel: _unreadOnly ? '未読の通知はありません' : '通知はありません',
            onData: (context, items) => ListView.separated(
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 8),
              itemCount: items.length,
              separatorBuilder: (_, __) => const SizedBox(height: 8),
              itemBuilder: (context, i) {
                final n = items[i];
                return Card(
                  child: ListTile(
                    leading: Icon(
                      n.isUnread ? Icons.circle : Icons.circle_outlined,
                      size: 14,
                      color: n.isUnread ? c.brand : c.textMuted,
                    ),
                    title: Text(
                      n.title,
                      style: TextStyle(
                        fontWeight: n.isUnread ? FontWeight.w600 : FontWeight.normal,
                      ),
                    ),
                    subtitle: Text(n.body, maxLines: 2, overflow: TextOverflow.ellipsis),
                    trailing: Text(
                      n.createdAt != null ? _fmtDate(n.createdAt!) : '',
                      style: TextStyle(color: c.textMuted, fontSize: 12),
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

String _fmtDate(DateTime d) =>
    '${d.month.toString().padLeft(2, '0')}/${d.day.toString().padLeft(2, '0')}';
