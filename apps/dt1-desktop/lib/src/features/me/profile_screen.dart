import 'package:dub_api_client/dub_api_client.dart';
import 'package:flutter/material.dart';

import '../../theme/app_theme.dart';
import '../../widgets/async_view.dart';
import 'me_repository.dart';

/// Profile: the composed identity view from the gateway's typed `/me`
/// (user, org, effective permissions, session expiry). Proves web→spec→Dart→UI
/// end to end (the original P0 vertical slice), now inside the shell.
class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key, required this.meRepository, this.onLogout});

  final MeRepository meRepository;
  final VoidCallback? onLogout;

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  late Future<MeResponse> _me = widget.meRepository.fetchMe();

  void _reload() => setState(() => _me = widget.meRepository.fetchMe());

  @override
  Widget build(BuildContext context) {
    final c = AppTheme.of(context);
    return AsyncView<MeResponse>(
      future: _me,
      onRetry: _reload,
      onData: (context, me) => ListView(
        padding: const EdgeInsets.all(24),
        children: [
          Row(
            children: [
              CircleAvatar(
                radius: 28,
                backgroundColor: c.brand,
                child: Text(
                  me.user.displayName.characters.first.toUpperCase(),
                  style: const TextStyle(color: Colors.white, fontSize: 22),
                ),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(me.user.displayName, style: Theme.of(context).textTheme.titleLarge),
                    Text('org: ${me.orgId}', style: TextStyle(color: c.textMuted)),
                  ],
                ),
              ),
              if (widget.onLogout != null)
                OutlinedButton.icon(
                  onPressed: widget.onLogout,
                  icon: const Icon(Icons.logout, size: 18),
                  label: const Text('サインアウト'),
                ),
            ],
          ),
          const SizedBox(height: 28),
          Text('権限 (${me.permissions.length})', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [for (final p in me.permissions) Chip(label: Text(p))],
          ),
          const SizedBox(height: 28),
          Text(
            'セッション有効期限: '
            '${DateTime.fromMillisecondsSinceEpoch(me.sessionExpiresAt)}',
            style: TextStyle(color: c.textMuted, fontSize: 13),
          ),
        ],
      ),
    );
  }
}
