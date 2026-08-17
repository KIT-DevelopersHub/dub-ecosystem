import 'package:flutter/material.dart';

import 'tokens.g.dart';

/// The DevHub desktop theme, built from the generated `@dub/tokens` tables
/// (`tokens.g.dart`) so the desktop palette equals the web SPA's by
/// construction. Regenerate the tables with `dart run tool/gen_theme.dart`
/// whenever `packages/tokens/tokens.json` changes — never hand-edit colours
/// here (roadmap §7, design-token sharing).
class AppTheme {
  static ThemeData light() => _build(Brightness.light, dubLight);
  static ThemeData dark() => _build(Brightness.dark, dubDark);

  /// The resolved token table for the active brightness — features read brand /
  /// status hues (success/warning/danger/info) that Material's ColorScheme has
  /// no slot for, straight off `Theme.of(context).extension<DubTokens>()`.
  static DubColors of(BuildContext context) =>
      Theme.of(context).extension<DubTokens>()?.colors ?? dubLight;

  static ThemeData _build(Brightness brightness, DubColors c) {
    final scheme = ColorScheme(
      brightness: brightness,
      primary: c.brand,
      onPrimary: c.textInverse,
      primaryContainer: c.brandSoft,
      onPrimaryContainer: c.textInverse,
      secondary: c.brandStrong,
      onSecondary: c.textInverse,
      error: c.danger,
      onError: c.textInverse,
      surface: c.surfaceBase,
      onSurface: c.textPrimary,
      surfaceContainerHighest: c.surfaceSunken,
      onSurfaceVariant: c.textSecondary,
      outline: c.borderDefault,
      outlineVariant: c.borderStrong,
    );

    return ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: scheme,
      scaffoldBackgroundColor: c.surfaceSunken,
      extensions: [DubTokens(colors: c)],
      dividerColor: c.borderDefault,
      appBarTheme: AppBarTheme(
        backgroundColor: c.surfaceBase,
        foregroundColor: c.textPrimary,
        elevation: 0,
        centerTitle: false,
      ),
      cardTheme: CardThemeData(
        color: c.surfaceRaised,
        elevation: 0,
        shape: RoundedRectangleBorder(
          side: BorderSide(color: c.borderDefault),
          borderRadius: BorderRadius.circular(12),
        ),
      ),
      chipTheme: ChipThemeData(
        backgroundColor: c.surfaceSunken,
        side: BorderSide(color: c.borderDefault),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: c.brand,
          foregroundColor: c.textInverse,
        ),
      ),
    );
  }
}

/// Carries the full resolved token table through the theme so features can read
/// brand + status hues that `ColorScheme` cannot express.
@immutable
class DubTokens extends ThemeExtension<DubTokens> {
  const DubTokens({required this.colors});

  final DubColors colors;

  @override
  DubTokens copyWith({DubColors? colors}) => DubTokens(colors: colors ?? this.colors);

  @override
  DubTokens lerp(ThemeExtension<DubTokens>? other, double t) => this;
}
