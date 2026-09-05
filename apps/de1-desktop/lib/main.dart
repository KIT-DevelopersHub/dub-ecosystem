import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'state/app_lock.dart';
import 'ui/lock_screen.dart';
import 'ui/web_shell.dart';

/// Dub desktop — a thin native shell that renders the real Web SPA.
///
/// The window is a literal copy of the web app (same login, same 9-dot
/// launcher, same screens) served by a full-bleed WebView pointed at the
/// production fe2 origin; it follows every web deploy for free and the session
/// cookie lives in the WebView's cookie store exactly as in a browser.
///
/// The *only* native code is the launch flow:
///   biometric gate (Touch ID / Windows Hello) → on success → WebView, into
///   whose login form the saved credentials are auto-filled.
/// See `ui/web_shell.dart`, `state/app_lock.dart`, `state/credential_store.dart`.
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const ProviderScope(child: DubDesktopApp()));
}

class DubDesktopApp extends StatelessWidget {
  const DubDesktopApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      title: 'Dub',
      debugShowCheckedModeBanner: false,
      home: _LockGate(),
    );
  }
}

/// Biometric launch gate. When armed (credentials saved + device can
/// authenticate) it sits in front of the WebView until the OS confirms the
/// owner; when disabled/unsupported/first-run it defers straight to the shell.
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
        return const WebShell();
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
