import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'state/app_lock.dart';
import 'state/auth.dart';
import 'ui/app_shell.dart';
import 'ui/lock_screen.dart';
import 'ui/login_screen.dart';
import 'ui/theme.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
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
      home: const _LockGate(),
    );
  }
}

/// Device-level launch gate. When the biometric app-lock is enabled it sits in
/// front of everything (login included) until the OS confirms the owner; when
/// disabled or unsupported it is transparent and defers straight to [_Root].
class _LockGate extends ConsumerWidget {
  const _LockGate();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final lock = ref.watch(appLockControllerProvider);
    switch (lock.phase) {
      case LockPhase.initializing:
        return const _Splash();
      case LockPhase.locked:
      case LockPhase.authenticating:
        return const LockScreen();
      case LockPhase.unlocked:
        return const _Root();
    }
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
