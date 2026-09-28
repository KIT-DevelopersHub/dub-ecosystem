import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

/// A single OS-notification-worthy event, normalised from either transport
/// (the in-page foreground watcher or an FCM remote push). [id] is the server
/// notification id — the dedup key shared across both transports so the same
/// notification is never shown twice.
@immutable
class PushEvent {
  const PushEvent({
    required this.id,
    required this.title,
    required this.body,
    this.url,
    this.type,
  });

  /// Server notification id (dedup key across foreground + remote transports).
  final String id;
  final String title;
  final String body;

  /// In-app deep-link path (e.g. `/tasks/task_123`) or null → open the inbox.
  final String? url;

  /// Notification type (open vocabulary), carried through for logging/routing.
  final String? type;

  factory PushEvent.fromMap(Map<dynamic, dynamic> m) {
    String s(dynamic v) => v?.toString() ?? '';
    final rawUrl = m['url']?.toString();
    return PushEvent(
      id: s(m['id']),
      title: s(m['title']),
      body: s(m['body']),
      url: (rawUrl == null || rawUrl.isEmpty) ? null : rawUrl,
      type: m['type']?.toString(),
    );
  }
}

/// Thin wrapper over `flutter_local_notifications` that owns:
///   * one-time plugin init + per-platform channel/category setup,
///   * cross-transport dedup (foreground watcher vs FCM remote), and
///   * tap → deep-link routing (the payload is the in-app path).
///
/// Display is uniform across macOS / Windows / iOS / Android; only the remote
/// *wake* differs per OS (that is FCM/APNs/WNS, layered on top separately).
class PushNotifications {
  PushNotifications._();

  static final PushNotifications instance = PushNotifications._();

  final FlutterLocalNotificationsPlugin _plugin =
      FlutterLocalNotificationsPlugin();

  /// Recently shown notification ids with an insertion order, so both the
  /// foreground watcher and a foreground FCM message dedup against the same set
  /// (the double-display guard from the design's 2経路モデル). Bounded FIFO.
  final _shownIds = <String>{};
  final _shownOrder = <String>[];
  static const _maxShown = 512;

  bool _initialised = false;

  /// Invoked when the user taps a notification. Wired by the shell to drive the
  /// WebView to the deep-link path. The argument is the in-app path (may be
  /// null → caller should open the inbox).
  void Function(String? path)? onSelectPath;

  static const _androidChannelId = 'dub_notifications';
  static const _androidChannelName = 'Dub 通知';
  static const _androidChannelDesc = 'メンション・DM・タスク等のお知らせ';

  Future<void> init() async {
    if (_initialised) return;
    _initialised = true;

    const androidInit = AndroidInitializationSettings('@mipmap/ic_launcher');
    const darwinInit = DarwinInitializationSettings(
      requestAlertPermission: true,
      requestBadgePermission: true,
      requestSoundPermission: true,
    );
    // Windows requires an app identity (AUMID/GUID). These are stable
    // registration strings, not secrets.
    const windowsInit = WindowsInitializationSettings(
      appName: 'Dub',
      appUserModelId: 'jp.developershub.dub_desktop',
      guid: '8b5f0d2a-3c1e-4a7b-9f6c-1d2e3a4b5c6d',
    );

    const settings = InitializationSettings(
      android: androidInit,
      iOS: darwinInit,
      macOS: darwinInit,
      windows: windowsInit,
    );

    await _plugin.initialize(
      settings,
      onDidReceiveNotificationResponse: _onTap,
    );

    if (!kIsWeb && Platform.isAndroid) {
      const channel = AndroidNotificationChannel(
        _androidChannelId,
        _androidChannelName,
        description: _androidChannelDesc,
        importance: Importance.high,
      );
      await _plugin
          .resolvePlatformSpecificImplementation<
              AndroidFlutterLocalNotificationsPlugin>()
          ?.createNotificationChannel(channel);
    }
  }

  /// Ask the OS for notification permission where an explicit opt-in is
  /// required (iOS/macOS always; Android 13+). Safe to call more than once.
  Future<void> requestPermission() async {
    if (kIsWeb) return;
    if (Platform.isIOS || Platform.isMacOS) {
      await _plugin
          .resolvePlatformSpecificImplementation<
              IOSFlutterLocalNotificationsPlugin>()
          ?.requestPermissions(alert: true, badge: true, sound: true);
      await _plugin
          .resolvePlatformSpecificImplementation<
              MacOSFlutterLocalNotificationsPlugin>()
          ?.requestPermissions(alert: true, badge: true, sound: true);
    } else if (Platform.isAndroid) {
      await _plugin
          .resolvePlatformSpecificImplementation<
              AndroidFlutterLocalNotificationsPlugin>()
          ?.requestNotificationsPermission();
    }
  }

  /// True if [id] was already shown recently (and records it if not). Used by
  /// both transports so a foreground remote push never duplicates a
  /// watcher-shown notification and vice-versa.
  bool _markShown(String id) {
    if (id.isEmpty) return false; // no id → cannot dedup; allow.
    if (_shownIds.contains(id)) return true;
    _shownIds.add(id);
    _shownOrder.add(id);
    if (_shownOrder.length > _maxShown) {
      final evicted = _shownOrder.removeAt(0);
      _shownIds.remove(evicted);
    }
    return false;
  }

  /// Show an OS notification for [event] unless it was already shown (dedup).
  /// Returns true if a notification was actually posted.
  Future<bool> show(PushEvent event) async {
    await init();
    if (_markShown(event.id)) return false;

    const androidDetails = AndroidNotificationDetails(
      _androidChannelId,
      _androidChannelName,
      channelDescription: _androidChannelDesc,
      importance: Importance.high,
      priority: Priority.high,
    );
    const darwinDetails = DarwinNotificationDetails(
      presentAlert: true,
      presentBadge: true,
      presentSound: true,
    );
    const windowsDetails = WindowsNotificationDetails();
    const details = NotificationDetails(
      android: androidDetails,
      iOS: darwinDetails,
      macOS: darwinDetails,
      windows: windowsDetails,
    );

    // A stable 31-bit int id derived from the string id keeps repeat updates of
    // the same notification collapsing rather than stacking.
    final intId = event.id.hashCode & 0x7fffffff;
    await _plugin.show(
      intId,
      event.title.isEmpty ? 'Dub' : event.title,
      event.body,
      details,
      payload: event.url ?? '',
    );
    return true;
  }

  /// Records [id] as shown WITHOUT posting a notification — used to claim the
  /// dedup slot for a notification the page's own UI already surfaced, so a
  /// later remote push for it stays silent.
  void markAlreadySurfaced(String id) => _markShown(id);

  void _onTap(NotificationResponse response) {
    final payload = response.payload;
    onSelectPath?.call((payload == null || payload.isEmpty) ? null : payload);
  }
}
