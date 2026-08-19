import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'state/auth.dart';
import 'ui/app_shell.dart';
import 'ui/login_screen.dart';
import 'ui/theme.dart';

void main() {
  runApp(const ProviderScope(child: DubDesktopApp()));
}

class DubDesktopApp extends StatelessWidget {
  const DubDesktopApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'DAV Desktop',
      debugShowCheckedModeBanner: false,
      theme: buildDubTheme(),
      home: const _Root(),
    );
  }
}

/// Top-level router: swaps between login and the app shell based on auth phase.
class _Root extends ConsumerWidget {
  const _Root();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final phase = ref.watch(authControllerProvider).phase;
    switch (phase) {
      case AuthPhase.unknown:
        return const _Splash();
      case AuthPhase.authenticated:
        return const AppShell();
      case AuthPhase.unauthenticated:
      case AuthPhase.authenticating:
        return const LoginScreen();
    }
  }
}

class _Splash extends StatelessWidget {
  const _Splash();

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(child: CircularProgressIndicator()),
    );
  }
}
