import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/auth.dart';
import '../ui/app_shell.dart';
import 'mobile_bff_client.dart';
import 'push_platform.dart';
import 'push_service.dart';

/// Bridges the push token to the mobile-bff: initialises [PushService] once the
/// user is authenticated, then (re)registers the device on every token change
/// (initial token + `onTokenRefresh`). Registration is best-effort — any
/// failure is logged and never surfaces to the user.
class PushRegistrar {
  PushRegistrar(this._ref);

  final Ref _ref;
  final MobileBffClient _bff = MobileBffClient.create();

  String? _deviceId;
  bool _started = false;
  VoidCallback? _tokenListener;
  VoidCallback? _tapListener;

  /// Called once the app shell mounts (i.e. the user is authenticated).
  Future<void> start() async {
    if (_started) return;
    _started = true;

    await PushService.instance.init();

    // Register the current token now (if any) and on every refresh.
    _tokenListener = () {
      final t = PushService.instance.token.value;
      if (t != null) _register(t);
    };
    PushService.instance.token.addListener(_tokenListener!);
    // Fire once for a token that arrived before we attached the listener.
    final current = PushService.instance.token.value;
    if (current != null) _register(current);

    // Route a notification tap to the relevant screen. Only the notifications
    // app is implemented today, so every deep-link opens that tab; richer
    // resource routing lands as more apps are built.
    _tapListener = () {
      final tap = PushService.instance.lastTap.value;
      if (tap == null) return;
      _ref.read(selectedAppProvider.notifier).state = 'notifications';
    };
    PushService.instance.lastTap.addListener(_tapListener!);
    if (PushService.instance.lastTap.value != null) _tapListener!();
  }

  Future<void> _register(String pushToken) async {
    final platform = currentPushPlatform();
    if (platform == null) return; // Windows / unsupported.
    try {
      final client = await _ref.read(gatewayClientProvider.future);
      final session = await client.sessionToken();
      if (session == null) {
        debugPrint('[push] no session token yet — deferring device register');
        return;
      }
      final id = await _bff.registerDevice(
        sessionToken: session,
        platform: platform,
        pushToken: pushToken,
      );
      if (id != null) {
        _deviceId = id;
        debugPrint('[push] device registered: $id ($platform)');
      } else {
        debugPrint('[push] device registration returned no id');
      }
    } catch (e) {
      debugPrint('[push] device registration failed: $e');
    }
  }

  /// Best-effort de-registration on logout. Must run BEFORE the session cookie
  /// is cleared (it needs the still-valid session token to authenticate).
  Future<void> unregister() async {
    final deviceId = _deviceId;
    if (deviceId == null) return;
    try {
      final client = await _ref.read(gatewayClientProvider.future);
      final session = await client.sessionToken();
      if (session == null) return;
      await _bff.unregisterDevice(sessionToken: session, deviceId: deviceId);
    } catch (e) {
      debugPrint('[push] device unregister failed: $e');
    } finally {
      _deviceId = null;
    }
  }

  void dispose() {
    final l = _tokenListener;
    if (l != null) PushService.instance.token.removeListener(l);
    final t = _tapListener;
    if (t != null) PushService.instance.lastTap.removeListener(t);
  }
}

/// App-lifetime registrar. Instantiated when the authenticated shell first reads
/// it (see `AppShell`), and again available to `AuthController.logout` for
/// best-effort de-registration.
final pushRegistrarProvider = Provider<PushRegistrar>((ref) {
  final registrar = PushRegistrar(ref);
  ref.onDispose(registrar.dispose);
  return registrar;
});
