import 'package:flutter/material.dart';

import 'src/api/gateway_client.dart';
import 'src/app/app_router.dart';
import 'src/config/app_config.dart';
import 'src/features/me/me_repository.dart';
import 'src/theme/app_theme.dart';

void main() {
  final config = AppConfig.fromEnvironment();
  final client = GatewayClientFactory(config).create();
  final meRepository = MeRepository(client);
  runApp(DubDesktopApp(router: AppRouter(meRepository)));
}

/// Root shell. Theme + routing "器"; screens are wired via [AppRouter].
class DubDesktopApp extends StatelessWidget {
  const DubDesktopApp({super.key, required this.router});

  final AppRouter router;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'DevHub Desktop',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      onGenerateRoute: router.onGenerateRoute,
      initialRoute: AppRouter.home,
    );
  }
}
