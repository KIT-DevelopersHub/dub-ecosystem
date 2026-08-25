/// Static app configuration.
///
/// [gatewayBaseUrl] is the single external boundary (api-gateway). It defaults
/// to the production origin but can be overridden at build/run time with
/// `--dart-define=GATEWAY_BASE_URL=http://localhost:8787` (e.g. to point at a
/// local wrangler dev gateway or the bundled mock in `tool/mock_gateway.dart`).
class AppConfig {
  const AppConfig._();

  static const String gatewayBaseUrl = String.fromEnvironment(
    'GATEWAY_BASE_URL',
    defaultValue: 'https://api.developershub.jp',
  );

  /// All public routes live under this prefix on the gateway.
  static const String apiPrefix = '/api/v1';

  // --- Dev-only affordances (never triggered in a release build unless the
  // caller explicitly passes the dart-defines). Used by the vertical-slice
  // screenshot harness to auto-drive the login screen. ---
  static const bool autoLogin =
      bool.fromEnvironment('AUTO_LOGIN', defaultValue: false);
  static const String autoLoginEmail =
      String.fromEnvironment('AUTO_LOGIN_EMAIL', defaultValue: '');
  static const String autoLoginPassword =
      String.fromEnvironment('AUTO_LOGIN_PASSWORD', defaultValue: '');
}
