import 'package:flutter/material.dart';

import '../features/me/home_screen.dart';
import '../features/me/me_repository.dart';

/// Minimal routing "器" (container).
///
/// P2 will derive routes/nav/permission-gates from the shared app-manifest SoT
/// (roadmap §4) so web and desktop expose the same app set. For P0 this is a
/// hand-listed table with a single Home route, kept small but extensible: add a
/// manifest-driven builder here later without touching call sites.
class AppRouter {
  const AppRouter(this.meRepository);

  final MeRepository meRepository;

  static const String home = '/';

  Route<dynamic> onGenerateRoute(RouteSettings settings) {
    switch (settings.name) {
      case home:
      default:
        return MaterialPageRoute<void>(
          settings: settings,
          builder: (_) => HomeScreen(meRepository: meRepository),
        );
    }
  }
}
