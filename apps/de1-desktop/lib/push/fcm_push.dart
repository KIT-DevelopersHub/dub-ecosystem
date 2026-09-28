import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:http/http.dart' as http;

import '../config.dart';
import '../firebase_options.dart';
import 'deep_link.dart';
import 'mo3_session.dart';
import 'push_notifications.dart';

/// Top-level background handler (required by firebase_messaging: must be a
/// top-level or static function annotated as an entry point). On Android a
/// data-only message that arrives while the app is terminated/backgrounded is
/// materialised into an OS notification here. A message that already carries a
/// `notification` block is shown by the system automatically, so we only
/// display when it is data-only to avoid a double.
@pragma('vm:entry-point')
Future<void> firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  if (message.notification != null) return; // system will display it
  final e = _toEvent(message);
  if (e == null) return;
  await PushNotifications.instance.show(e);
}

PushEvent? _toEvent(RemoteMessage message) {
  final data = message.data;
  final notif = message.notification;
  final title = notif?.title ?? data['title'] ?? 'Dub';
  final body = notif?.body ?? data['body'] ?? '';
  // dedup id: the server convention is data.notificationId (see mo1/mo2).
  final id = (data['notificationId'] ?? data['id'] ?? message.messageId ?? '')
      .toString();
  final path = resolveDeepLink(data['deepLink']?.toString());
  if (id.isEmpty && title.isEmpty && body.isEmpty) return null;
  return PushEvent(id: id, title: title, body: body, url: path, type: data['type']?.toString());
}

/// Async provider of a mobile bearer token for the mo3 devices API.
///
/// Normal path: null (there is no mobile login/token-exchange step in de1) —
/// [_register] then falls back to the WebView's `dub_session` cookie, which
/// `mo3-mobile-bff` accepts directly for this route (see
/// `apps/mo3-mobile-bff/src/app.ts` `cookieSession()`, added for exactly this
/// track). A `--dart-define=MOBILE_BEARER=...` bearer is honoured first when
/// present, for local end-to-end testing against a native-style Bearer token.
typedef MobileBearerProvider = Future<String?> Function();

/// Phase 1 — Android remote push (background/cold) via FCM, at $0 in code.
///
/// Responsibilities:
///   * initialise Firebase (guarded: a missing google-services.json just skips
///     remote push; Phase 0 foreground notifications keep working),
///   * obtain + refresh the FCM device token and register it with mo3
///     (`POST /m/v1/devices`, platform "android"),
///   * show background/terminated data-messages as OS notifications, and
///   * SUPPRESS foreground FCM messages so they never double with the Phase 0
///     in-page watcher (the watcher owns foreground display).
class FcmPush {
  FcmPush({MobileBearerProvider? bearerProvider})
      : _bearerProvider = bearerProvider ?? _defaultBearerProvider;

  static const _mobileBearerDefine =
      String.fromEnvironment('MOBILE_BEARER', defaultValue: '');

  static Future<String?> _defaultBearerProvider() async =>
      _mobileBearerDefine.isEmpty ? null : _mobileBearerDefine;

  final MobileBearerProvider _bearerProvider;
  String? _pendingToken; // token awaiting a bearer to register with

  /// The last FCM registration token obtained via [init]/refresh, exposed for
  /// debug/testing surfaces (see [onTokenChanged] and `web_shell.dart`'s debug
  /// panel). Never sent anywhere except mo3 (`_register`) and the on-screen
  /// debug display gated behind [kDebugMode].
  String? _lastToken;
  String? get lastToken => _lastToken;

  /// Notified whenever a (possibly refreshed) FCM token is obtained. Wired by
  /// the UI so a debug panel can show/copy the token without polling.
  ValueChanged<String>? onTokenChanged;

  /// Android = production FCM path. macOS is enabled too (FCM-over-APNs) so a
  /// registration token can be obtained here for push-notification testing —
  /// see ADR-0006 follow-up ("APNs/FCM-style transport later"). iOS follows
  /// the same code path once shipped; Windows has no FCM/APNs equivalent and
  /// stays on [NativePush] (WNS).
  static bool get isSupported =>
      !kIsWeb && (Platform.isAndroid || Platform.isMacOS || Platform.isIOS);

  /// mo3's `platform` string for the current OS (`_register` was previously
  /// Android-only and hardcoded this; now that macOS/iOS share this class it
  /// must report the real OS so mo3's APNs-vs-FCM adapter routing is correct).
  static String get _mobilePlatform {
    if (Platform.isMacOS) return 'macos';
    if (Platform.isIOS) return 'ios';
    return 'android';
  }

  Future<void> init() async {
    if (!isSupported) return;
    try {
      await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
    } catch (e) {
      // No/invalid Firebase config → remote push is simply unavailable.
      // Phase 0 foreground notifications are unaffected.
      debugPrint('[push] Firebase not configured; remote push disabled ($e)');
      return;
    }

    await PushNotifications.instance.init();
    await PushNotifications.instance.requestPermission();

    FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);

    // Foreground: DO NOT display — the Phase 0 watcher owns foreground display,
    // so showing here would double. We still claim the dedup slot by id so that
    // if the watcher poll and this message race, only one wins.
    FirebaseMessaging.onMessage.listen((message) {
      final data = message.data;
      final id = (data['notificationId'] ?? data['id'] ?? '').toString();
      if (id.isNotEmpty) PushNotifications.instance.markAlreadySurfaced(id);
    });

    // A tap on a notification that opened/upgraded the app → route it.
    FirebaseMessaging.onMessageOpenedApp.listen(_handleOpenedApp);
    final initial = await FirebaseMessaging.instance.getInitialMessage();
    if (initial != null) _handleOpenedApp(initial);

    final messaging = FirebaseMessaging.instance;
    await messaging.requestPermission();
    final token = await messaging.getToken();
    if (token != null) _onToken(token);
    messaging.onTokenRefresh.listen(_onToken);
  }

  /// Records + surfaces a (possibly refreshed) FCM token, then attempts mo3
  /// registration. Logged with a fixed, greppable prefix so it can be pulled
  /// out of `flutter run` / Console.app output for manual push testing —
  /// never sent anywhere but mo3 and this process's own log/debug panel.
  void _onToken(String token) {
    _lastToken = token;
    debugPrint('[FCM_TOKEN] $token');
    onTokenChanged?.call(token);
    unawaited(_register(token));
  }

  void _handleOpenedApp(RemoteMessage message) {
    final path = resolveDeepLink(message.data['deepLink']?.toString());
    PushNotifications.instance.onSelectPath?.call(path);
  }

  /// Register (or refresh) the FCM token with mo3. Idempotent server-side on
  /// `(platform, pushToken)`. Auth is a `--dart-define=MOBILE_BEARER` bearer
  /// when supplied (testing), else the WebView's own `dub_session` cookie
  /// (see [readDubSessionCookie]) — either is deferred/retried if unavailable
  /// (e.g. before login).
  Future<void> _register(String token) async {
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
        _pendingToken = token; // cache; a later auth completes registration
        debugPrint('[push] FCM token acquired but no mo3 auth yet — deferred');
        return;
      }
      headers['cookie'] = 'dub_session=$sessionCookie';
    }
    try {
      final res = await http.post(
        Uri.parse('${AppConfig.mo3BaseUrl}/m/v1/devices'),
        headers: headers,
        body: jsonEncode({'platform': _mobilePlatform, 'pushToken': token}),
      );
      if (res.statusCode == 201) {
        _pendingToken = null;
        debugPrint('[push] device registered with mo3');
      } else {
        _pendingToken = token;
        debugPrint('[push] device registration failed: ${res.statusCode}');
      }
    } catch (e) {
      _pendingToken = token;
      debugPrint('[push] device registration error: $e');
    }
  }

  /// Retry a deferred registration once a mo3 bearer becomes available (e.g.
  /// after the mobile auth exchange seam lands).
  Future<void> retryPendingRegistration() async {
    final t = _pendingToken;
    if (t != null) await _register(t);
  }
}
