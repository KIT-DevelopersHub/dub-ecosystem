import 'package:flutter/material.dart';

/// Brand seed roughly matching the DevHub/Dub web palette. The web design
/// system (@dub/tokens) is the source of truth; this is a lightweight
/// approximation for the scaffold until tokens are wired in.
const Color _dubSeed = Color(0xFF4F46E5); // indigo-600

ThemeData buildDubTheme() {
  final scheme = ColorScheme.fromSeed(
    seedColor: _dubSeed,
    brightness: Brightness.light,
  );
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: const Color(0xFFF7F7FB),
    visualDensity: VisualDensity.comfortable,
  );
}
