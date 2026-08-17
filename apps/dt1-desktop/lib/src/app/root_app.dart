import 'package:flutter/material.dart';

import '../auth/auth_controller.dart';
import '../auth/login_screen.dart';
import '../theme/app_theme.dart';
import 'app_shell.dart';
import 'services.dart';

/// Root of the desktop app. Owns theming and the auth gate: signed-out → the
/// login screen; signed-in → the shell. The gate rebuilds on [AuthController]
/// changes, so login/logout swap the whole surface with no manual navigation.
class DubDesktopApp extends StatelessWidget {
  const DubDesktopApp({super.key, required this.services});

  final AppServices services;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'DevHub Desktop',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      home: _AuthGate(services: services),
    );
  }
}

class _AuthGate extends StatelessWidget {
  const _AuthGate({required this.services});

  final AppServices services;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: services.auth,
      builder: (context, _) {
        final auth = services.auth;
        if (auth.status == AuthStatus.signedIn && auth.me != null) {
          return AppShell(services: services, me: auth.me!);
        }
        return LoginScreen(auth: auth);
      },
    );
  }
}
