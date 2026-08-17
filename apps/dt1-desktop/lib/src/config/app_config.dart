/// Runtime configuration for the desktop shell.
///
/// The API base URL is injected at build/run time so the same binary can point
/// at a local mock, a preview gateway, or production without code changes:
///
///   flutter run    --dart-define=DUB_API_BASE=http://127.0.0.1:8787
///   flutter build macos --dart-define=DUB_API_BASE=https://api.developershub.jp
///
/// Default is the production gateway (matches the web SPA boundary). Desktop is
/// online-first and talks to the SAME api-gateway as web (no desktop BFF — see
/// the Flutter desktop roadmap §5).
class AppConfig {
  const AppConfig({required this.apiBaseUrl});

  final String apiBaseUrl;

  static const String _defaultBase = 'https://api.developershub.jp';

  factory AppConfig.fromEnvironment() {
    const base = String.fromEnvironment('DUB_API_BASE', defaultValue: _defaultBase);
    return const AppConfig(apiBaseUrl: base);
  }
}
