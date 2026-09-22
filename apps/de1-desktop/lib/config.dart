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

  /// The dedicated mobile-bff face (`m-api.developershub.jp`, theme14 D5). Push
  /// device registration (`/m/v1/devices`) lives here, NOT on the api-gateway —
  /// the gateway holds no mobile face. Overridable with
  /// `--dart-define=MOBILE_BFF_BASE_URL=http://localhost:8788` for local dev.
  static const String mobileBffBaseUrl = String.fromEnvironment(
    'MOBILE_BFF_BASE_URL',
    defaultValue: 'https://m-api.developershub.jp',
  );

  /// Device-registration route prefix on the mobile-bff.
  static const String mobilePrefix = '/m/v1';

  /// Master switch for the background-push client. Defaults on; set
  /// `--dart-define=PUSH_ENABLED=false` to fully disable Firebase init (e.g. the
  /// screenshot harness or a build without the Firebase config files).
  static const bool pushEnabled =
      bool.fromEnvironment('PUSH_ENABLED', defaultValue: true);

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
