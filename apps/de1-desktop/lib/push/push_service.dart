import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../config.dart';
import 'push_platform.dart';

/// A tap on a delivered notification, surfaced to the app so it can deep-link
/// the WebView / inbox to the right resource.
class PushTap {
  const PushTap({this.url, this.resourceType, this.resourceId});

  /// Explicit deep-link URL from the payload `data.url`, if the server sent one.
  final String? url;
  final String? resourceType;
  final String? resourceId;

  bool get isEmpty => url == null && resourceType == null && resourceId == null;

  factory PushTap.fromData(Map<String, dynamic> data) => PushTap(
        url: data['url'] as String?,
        resourceType: data['resourceType'] as String?,
        resourceId: data['resourceId'] as String?,
      );
}

/// Top-level background/terminated message handler. MUST be a top-level (or
/// static) function annotated with `@pragma('vm:entry-point')` — the Flutter
/// engine spins up a background isolate for it, so it cannot be a closure. Kept
/// deliberately minimal: on Android an FCM *notification* message is rendered by
/// the OS automatically, so there is nothing to draw here; we only ensure
/// Firebase is initialised in this isolate (required before touching any
/// Firebase API) so future data-only handling has a valid app.
@pragma('vm:entry-point')
Future<void> firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  try {
    await Firebase.initializeApp();
  } catch (_) {
    // No Firebase config in this isolate — nothing we can do; drop silently.
  }
}

/// Owns the Firebase Messaging lifecycle: permission, token acquisition +
/// refresh, and foreground/background/terminated presentation. Push is a
/// best-effort enhancement — every native call is guarded so a missing Firebase
/// config file (see docs/desktop-flutter/PUSH_SETUP.md) degrades to a no-op
/// instead of crashing the app.
class PushService {
  PushService._();

  static final PushService instance = PushService._();

  final FlutterLocalNotificationsPlugin _localNotifications =
      FlutterLocalNotificationsPlugin();

  /// Emits the current FCM token (and every refresh). Null until the first
  /// token is obtained, or when push is unsupported/unconfigured.
  final ValueNotifier<String?> token = ValueNotifier<String?>(null);

  /// Emits the most recent notification tap for the app to act on (deep-link).
  final ValueNotifier<PushTap?> lastTap = ValueNotifier<PushTap?>(null);

  bool _initialised = false;
  bool _available = false;

  static const AndroidNotificationChannel _channel = AndroidNotificationChannel(
    'dub_default',
    'Dub 通知',
    description: 'DevelopersHub からの通知',
    importance: Importance.high,
  );

  /// Whether Firebase initialised and this platform can receive FCM pushes.
  bool get available => _available;

  /// Registers the background handler. Call once from `main()` AFTER
  /// `WidgetsFlutterBinding.ensureInitialized()` and BEFORE `runApp`.
  static void registerBackgroundHandler() {
    if (!AppConfig.pushEnabled || !isFcmSupportedPlatform) return;
    try {
      FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);
    } catch (e) {
      debugPrint('[push] background handler registration skipped: $e');
    }
  }

  /// Idempotent. Initialises Firebase, local notifications, permission and the
  /// message listeners. Safe to call when push is disabled/unsupported (no-op).
  Future<void> init() async {
    if (_initialised) return;
    _initialised = true;

    if (!AppConfig.pushEnabled) {
      debugPrint('[push] disabled via PUSH_ENABLED=false');
      return;
    }
    if (!isFcmSupportedPlatform) {
      // Windows (WNS) and unsupported OSes: no firebase_messaging client.
      debugPrint('[push] FCM transport unavailable on this platform — skipped');
      return;
    }

    try {
      await Firebase.initializeApp();
    } catch (e) {
      debugPrint('[push] Firebase.initializeApp failed (missing config?): $e');
      return;
    }

    await _setupLocalNotifications();

    final messaging = FirebaseMessaging.instance;
    try {
      await messaging.requestPermission();
      // Show foreground notifications on Apple platforms via the system too.
      await messaging.setForegroundNotificationPresentationOptions(
        alert: true,
        badge: true,
        sound: true,
      );
    } catch (e) {
      debugPrint('[push] permission/presentation setup failed: $e');
    }

    // Foreground messages: render locally (Android does not auto-display these).
    FirebaseMessaging.onMessage.listen(_onForegroundMessage);
    // Tap while backgrounded (app alive): deep-link.
    FirebaseMessaging.onMessageOpenedApp.listen(_onMessageOpenedApp);

    // Cold-start from a notification tap (terminated): replay the deep-link.
    try {
      final initial = await messaging.getInitialMessage();
      if (initial != null) _emitTap(initial);
    } catch (e) {
      debugPrint('[push] getInitialMessage failed: $e');
    }

    // Token + refresh.
    try {
      final t = await messaging.getToken();
      if (t != null) token.value = t;
      messaging.onTokenRefresh.listen((t) => token.value = t);
      _available = true;
    } catch (e) {
      debugPrint('[push] getToken failed: $e');
    }
  }

  Future<void> _setupLocalNotifications() async {
    const androidInit = AndroidInitializationSettings('@mipmap/ic_launcher');
    const darwinInit = DarwinInitializationSettings(
      requestAlertPermission: false,
      requestBadgePermission: false,
      requestSoundPermission: false,
    );
    const settings = InitializationSettings(
      android: androidInit,
      iOS: darwinInit,
      macOS: darwinInit,
    );
    try {
      await _localNotifications.initialize(
        settings,
        onDidReceiveNotificationResponse: _onLocalTap,
      );
      await _localNotifications
          .resolvePlatformSpecificImplementation<
              AndroidFlutterLocalNotificationsPlugin>()
          ?.createNotificationChannel(_channel);
    } catch (e) {
      debugPrint('[push] local notifications init failed: $e');
    }
  }

  void _onForegroundMessage(RemoteMessage message) {
    final n = message.notification;
    final title = n?.title ?? message.data['title'] as String?;
    final body = n?.body ?? message.data['body'] as String?;
    if (title == null && body == null) return;

    final details = NotificationDetails(
      android: AndroidNotificationDetails(
        _channel.id,
        _channel.name,
        channelDescription: _channel.description,
        importance: Importance.high,
        priority: Priority.high,
      ),
      iOS: const DarwinNotificationDetails(),
      macOS: const DarwinNotificationDetails(),
    );
    try {
      _localNotifications.show(
        message.hashCode,
        title,
        body,
        details,
        payload: _encodePayload(message.data),
      );
    } catch (e) {
      debugPrint('[push] show foreground notification failed: $e');
    }
  }

  void _onMessageOpenedApp(RemoteMessage message) => _emitTap(message);

  void _emitTap(RemoteMessage message) {
    final tap = PushTap.fromData(message.data);
    if (!tap.isEmpty) lastTap.value = tap;
  }

  void _onLocalTap(NotificationResponse response) {
    final payload = response.payload;
    if (payload == null || payload.isEmpty) return;
    final tap = PushTap.fromData(_decodePayload(payload));
    if (!tap.isEmpty) lastTap.value = tap;
  }

  // Payloads are flat string maps; encode as `k=v` joined by `\n` to avoid a
  // json dependency for the tiny deep-link set.
  String _encodePayload(Map<String, dynamic> data) => data.entries
      .where((e) => e.value is String)
      .map((e) => '${e.key}=${e.value}')
      .join('\n');

  Map<String, dynamic> _decodePayload(String payload) {
    final map = <String, dynamic>{};
    for (final line in payload.split('\n')) {
      final i = line.indexOf('=');
      if (i > 0) map[line.substring(0, i)] = line.substring(i + 1);
    }
    return map;
  }
}
