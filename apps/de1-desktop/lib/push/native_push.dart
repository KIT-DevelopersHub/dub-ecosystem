import 'dart:convert';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import '../config.dart';
import 'fcm_push.dart' show MobileBearerProvider;
import 'mo3_session.dart';

/// Phase 2/3 — background remote push for the platforms FCM does not cover:
///   * iOS / macOS  → APNs (native `registerForRemoteNotifications`, raw device token)
///   * Windows      → WNS  (native `PushNotificationChannelManager`, Channel URI)
///
/// Android stays on [FcmPush]; this controller is a no-op there. The native
/// side (AppDelegate on Apple, the C++ runner on Windows) does the OS
/// registration and hands the token/Channel-URI back over a single
/// [MethodChannel]; this Dart side owns the mo3 registration call, the
/// deferred-bearer retry, and platform gating — exactly mirroring [FcmPush] so
/// the two transports behave identically from the app's point of view.
///
/// The server (mo3-mobile-bff) routes by the `platform` value: `ios`/`macos`
/// → its APNs adapter (macOS uses its own apns-topic), `windows` → the WNS
/// adapter. The `pushToken` field is the raw APNs hex token on Apple and the
/// full WNS Channel URI on Windows.
class NativePush {
  NativePush({
    MobileBearerProvider? bearerProvider,
    MethodChannel? channel,
    http.Client? httpClient,
    String? platformOverride,
  })  : _bearerProvider = bearerProvider ?? _defaultBearerProvider,
        _channel = channel ?? const MethodChannel(channelName),
        _http = httpClient ?? http.Client(),
        _platformOverride = platformOverride;

  /// The single native<->Dart channel. The native handlers implement
  /// `registerForPush` (Dart→native, returns the token/URI) and invoke
  /// `onPushToken` (native→Dart) on refresh / late delivery.
  static const String channelName = 'jp.developershub.dub/native_push';

  static const String _mobileBearerDefine =
      String.fromEnvironment('MOBILE_BEARER', defaultValue: '');

  static Future<String?> _defaultBearerProvider() async =>
      _mobileBearerDefine.isEmpty ? null : _mobileBearerDefine;

  final MobileBearerProvider _bearerProvider;
  final MethodChannel _channel;
  final http.Client _http;
  final String? _platformOverride;

  String? _pendingToken; // token/URI awaiting a bearer to register with
  String? _pendingPlatform;

  /// The mo3 `platform` string for the current OS, or null where this
  /// controller does nothing (web, Android → FcmPush, anything else).
  String? get mobilePlatform {
    final p = _platformOverride ?? _currentPlatform();
    return (p == 'ios' || p == 'macos' || p == 'windows') ? p : null;
  }

  static String _currentPlatform() {
    if (kIsWeb) return 'web';
    if (Platform.isIOS) return 'ios';
    if (Platform.isMacOS) return 'macos';
    if (Platform.isWindows) return 'windows';
    if (Platform.isAndroid) return 'android';
    return 'other';
  }

  /// True only where APNs/WNS remote push applies (iOS/macOS/Windows).
  bool get isSupported => mobilePlatform != null;

  Future<void> init() async {
    final platform = mobilePlatform;
    if (platform == null) return;

    // Native → Dart: a refreshed APNs token or a renewed WNS Channel URI.
    _channel.setMethodCallHandler((call) async {
      if (call.method == 'onPushToken') {
        final token = _tokenArg(call.arguments);
        if (token != null) await _register(platform, token);
      }
      return null;
    });

    try {
      // iOS/macOS → raw APNs device token (hex). Windows → WNS Channel URI.
      final token = await _channel.invokeMethod<String>('registerForPush');
      if (token != null && token.isNotEmpty) await _register(platform, token);
    } on MissingPluginException {
      // Native handler not wired for this build (e.g. an unsigned dev run):
      // remote push is simply unavailable; foreground notifications keep working.
      debugPrint('[push] native push channel not implemented on $platform');
    } on PlatformException catch (e) {
      debugPrint('[push] native push registration failed: ${e.message}');
    }
  }

  static String? _tokenArg(Object? args) {
    final token = (args is Map) ? args['token']?.toString() : null;
    return (token == null || token.isEmpty) ? null : token;
  }

  /// Register (or refresh) the device token with mo3. Idempotent server-side on
  /// `(platform, pushToken)`. Auth mirrors [FcmPush._register]: a
  /// `--dart-define=MOBILE_BEARER` bearer when supplied (testing), else the
  /// WebView's own `dub_session` cookie (see [readDubSessionCookie]) — either
  /// is deferred/retried if unavailable (e.g. before login).
  Future<void> _register(String platform, String token) async {
    final bearer = await _bearerProvider();
    final headers = {
      'content-type': 'application/json',
      'accept': 'application/json',
    };
    if (bearer != null && bearer.isNotEmpty) {
      headers['authorization'] = 'Bearer $bearer';
    } else {
      final sessionCookie = await readDubSessionCookie();
      if (sessionCookie == null) {
        _pendingToken = token;
        _pendingPlatform = platform;
        debugPrint('[push] $platform token acquired but no mo3 auth yet — deferred');
        return;
      }
      headers['cookie'] = 'dub_session=$sessionCookie';
    }
    try {
      final res = await _http.post(
        Uri.parse('${AppConfig.mo3BaseUrl}/m/v1/devices'),
        headers: headers,
        body: jsonEncode({'platform': platform, 'pushToken': token}),
      );
      if (res.statusCode == 201) {
        _pendingToken = null;
        _pendingPlatform = null;
        debugPrint('[push] $platform device registered with mo3');
      } else {
        _pendingToken = token;
        _pendingPlatform = platform;
        debugPrint('[push] $platform device registration failed: ${res.statusCode}');
      }
    } catch (e) {
      _pendingToken = token;
      _pendingPlatform = platform;
      debugPrint('[push] $platform device registration error: $e');
    }
  }

  /// Retry a deferred registration once a mo3 bearer becomes available.
  Future<void> retryPendingRegistration() async {
    final t = _pendingToken;
    final p = _pendingPlatform;
    if (t != null && p != null) await _register(p, t);
  }

  @visibleForTesting
  bool get hasPendingRegistration => _pendingToken != null;
}
