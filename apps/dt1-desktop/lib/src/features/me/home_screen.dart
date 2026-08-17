import 'package:dub_api_client/dub_api_client.dart';
import 'package:flutter/material.dart';

import 'me_repository.dart';

/// P0 vertical-slice screen: fetch `/me` through the generated Dart client and
/// render the composed identity view. Proves web→spec→Dart→UI is wired end to
/// end. Real apps (gantt, mail, …) land on this same pattern in P2.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.meRepository});

  final MeRepository meRepository;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  late Future<MeResponse> _me;

  @override
  void initState() {
    super.initState();
    _me = widget.meRepository.fetchMe();
  }

  void _reload() {
    setState(() {
      _me = widget.meRepository.fetchMe();
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('DevHub Desktop'),
        actions: [
          IconButton(
            onPressed: _reload,
            icon: const Icon(Icons.refresh),
            tooltip: 'Reload /me',
          ),
        ],
      ),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: FutureBuilder<MeResponse>(
            future: _me,
            builder: (context, snapshot) {
              if (snapshot.connectionState != ConnectionState.done) {
                return const CircularProgressIndicator();
              }
              if (snapshot.hasError) {
                return _ErrorView(error: snapshot.error!, onRetry: _reload);
              }
              return _MeView(me: snapshot.data!);
            },
          ),
        ),
      ),
    );
  }
}

class _MeView extends StatelessWidget {
  const _MeView({required this.me});

  final MeResponse me;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              CircleAvatar(
                radius: 24,
                child: Text(
                  me.user.displayName.characters.first.toUpperCase(),
                ),
              ),
              const SizedBox(width: 16),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(me.user.displayName, style: theme.textTheme.titleLarge),
                  Text('org: ${me.orgId}', style: theme.textTheme.bodyMedium),
                ],
              ),
            ],
          ),
          const SizedBox(height: 24),
          Text('Permissions (${me.permissions.length})',
              style: theme.textTheme.titleMedium),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final p in me.permissions) Chip(label: Text(p)),
            ],
          ),
          const SizedBox(height: 24),
          Text(
            'session expires: '
            '${DateTime.fromMillisecondsSinceEpoch(me.sessionExpiresAt)}',
            style: theme.textTheme.bodySmall,
          ),
        ],
      ),
    );
  }
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.error, required this.onRetry});

  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.error_outline,
              color: Theme.of(context).colorScheme.error, size: 40),
          const SizedBox(height: 12),
          Text('Could not load /me',
              style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          Text('$error', textAlign: TextAlign.center),
          const SizedBox(height: 16),
          FilledButton(onPressed: onRetry, child: const Text('Retry')),
        ],
      ),
    );
  }
}
