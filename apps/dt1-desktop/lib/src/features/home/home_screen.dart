import 'package:dub_api_client/dub_api_client.dart';
import 'package:flutter/material.dart';

import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import 'home_repository.dart';

/// Dashboard: the gateway's typed `/bff/home` composition — upcoming events and
/// the unread-notification count in one call, degraded upstreams surfaced.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.repository, required this.userName});

  final HomeRepository repository;
  final String userName;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  late Future<BffHomeResponse> _future = widget.repository.fetchHome();

  void _reload() => setState(() => _future = widget.repository.fetchHome());

  @override
  Widget build(BuildContext context) {
    final c = AppTheme.of(context);
    return AsyncView<BffHomeResponse>(
      future: _future,
      onRetry: _reload,
      onData: (context, home) {
        return ListView(
          padding: const EdgeInsets.all(24),
          children: [
            Text('こんにちは、${widget.userName} さん',
                style: Theme.of(context).textTheme.headlineSmall),
            const SizedBox(height: 4),
            Text('今日のダッシュボード', style: TextStyle(color: c.textMuted)),
            const SizedBox(height: 20),
            Row(
              children: [
                _StatCard(
                  icon: Icons.event,
                  label: '近日のイベント',
                  value: '${home.upcomingEvents.length}',
                  color: c.brand,
                ),
                const SizedBox(width: 16),
                _StatCard(
                  icon: Icons.notifications_active_outlined,
                  label: '未読の通知',
                  value: '${home.unreadCount}',
                  color: c.warning,
                ),
              ],
            ),
            if (home.partialErrors.isNotEmpty) ...[
              const SizedBox(height: 16),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: c.surfaceSunken,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: c.borderDefault),
                ),
                child: Row(
                  children: [
                    Icon(Icons.info_outline, size: 18, color: c.textMuted),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        '一部の情報を取得できませんでした（${home.partialErrors.map((e) => e.code).join(', ')}）。',
                        style: TextStyle(color: c.textMuted, fontSize: 13),
                      ),
                    ),
                  ],
                ),
              ),
            ],
            const SizedBox(height: 24),
            Text('近日のイベント', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            if (home.upcomingEvents.isEmpty)
              Text('予定されたイベントはありません', style: TextStyle(color: c.textMuted))
            else
              ...home.upcomingEvents.map((e) => Card(
                    child: ListTile(
                      leading: Icon(Icons.event, color: c.brand),
                      title: Text(e.title),
                      subtitle: Text(
                        e.startsAt != null
                            ? _fmtDate(e.startsAt!)
                            : e.phase.name,
                      ),
                    ),
                  )),
          ],
        );
      },
    );
  }
}

String _fmtDate(DateTime d) =>
    '${d.year}/${d.month.toString().padLeft(2, '0')}/${d.day.toString().padLeft(2, '0')}';

class _StatCard extends StatelessWidget {
  const _StatCard({
    required this.icon,
    required this.label,
    required this.value,
    required this.color,
  });

  final IconData icon;
  final String label;
  final String value;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final c = AppTheme.of(context);
    return Expanded(
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Row(
            children: [
              Container(
                height: 44,
                width: 44,
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Icon(icon, color: color),
              ),
              const SizedBox(width: 14),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(value, style: Theme.of(context).textTheme.headlineSmall),
                  Text(label, style: TextStyle(color: c.textMuted, fontSize: 13)),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
