import 'package:flutter/material.dart';

/// App theme "器" (container). P1 will generate these values from
/// `@dub/tokens` (DTCG) so the desktop look matches the web SPA exactly
/// (roadmap §7 — design-token sharing). For P0 this is a hand-set seed that
/// approximates the web brand and exposes light + dark.
class AppTheme {
  static const Color _seed = Color(0xFF4F46E5); // indigo — web brand primary

  static ThemeData light() => _base(Brightness.light);
  static ThemeData dark() => _base(Brightness.dark);

  static ThemeData _base(Brightness brightness) {
    final scheme = ColorScheme.fromSeed(
      seedColor: _seed,
      brightness: brightness,
    );
    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      scaffoldBackgroundColor: scheme.surface,
      appBarTheme: AppBarTheme(
        backgroundColor: scheme.surface,
        foregroundColor: scheme.onSurface,
        elevation: 0,
        centerTitle: false,
      ),
    );
  }
}
