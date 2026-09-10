import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:local_auth/local_auth.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Device-level app lock (launch gate) backed by the OS biometric stack.
///
/// This is a *separate layer* from the Dub account session (email + password
/// handled in [AuthController]): unlocking the device gate proves the person
/// holding the machine is its owner (Touch ID on macOS, Windows Hello on
/// Windows, with a passcode/password fallback), and only then does the app
/// reveal its content — at which point the normal Dub session applies.
enum LockPhase {
  /// Still probing platform support / persisted preference.
  initializing,

  /// Lock disabled, or platform can't authenticate → app is open.
  unlocked,

  /// Lock enabled and the gate has not been passed this launch.
  locked,

  /// A biometric/passcode prompt is currently on screen.
  authenticating,
}

@immutable
class LockState {
  const LockState({
    required this.phase,
    required this.enabled,
    required this.supported,
    this.error,
  });

  const LockState.initial()
      : phase = LockPhase.initializing,
        enabled = false,
        supported = false,
        error = null;

  /// Current gate phase.
  final LockPhase phase;

  /// User preference: is the launch gate switched on?
  final bool enabled;

  /// Whether this platform/device can perform *any* authentication
  /// (biometric or device passcode). When false the gate is a no-op so the
  /// user is never locked out of their own app.
  final bool supported;

  /// Last authentication error message (for display), if any.
  final String? error;

  bool get isLocked => phase == LockPhase.locked;

  LockState copyWith({
    LockPhase? phase,
    bool? enabled,
    bool? supported,
    String? error,
    bool clearError = false,
  }) {
    return LockState(
      phase: phase ?? this.phase,
      enabled: enabled ?? this.enabled,
      supported: supported ?? this.supported,
      error: clearError ? null : (error ?? this.error),
    );
  }
}

/// Thin seam over [LocalAuthentication] so the controller stays testable and
/// so we can no-op on platforms without a biometric implementation.
class BiometricGate {
  BiometricGate([LocalAuthentication? auth])
      : _auth = auth ?? LocalAuthentication();

  final LocalAuthentication _auth;

  /// local_auth ships implementations for macOS, Windows, iOS and Android.
  /// The desktop client only builds macOS + Windows today, but we guard by
  /// platform so a future mobile target (or a Linux build without a plugin)
  /// degrades gracefully instead of throwing.
  bool get _platformHasPlugin =>
      !kIsWeb &&
      (Platform.isMacOS ||
          Platform.isWindows ||
          Platform.isIOS ||
          Platform.isAndroid);

  /// True when the device can authenticate the user by *some* means —
  /// biometrics if enrolled, otherwise the device passcode/password.
  Future<bool> canAuthenticate() async {
    if (!_platformHasPlugin) return false;
    try {
      // `isDeviceSupported` covers the passcode-only fallback path;
      // `canCheckBiometrics` covers enrolled biometrics. Either is enough
      // because we authenticate with `biometricOnly: false`.
      final supported = await _auth.isDeviceSupported();
      return supported;
    } on Exception {
      return false;
    }
  }

  /// Prompts the OS authentication UI. Returns true only on a confirmed match.
  /// Falls back to the device passcode/password when biometrics are
  /// unavailable or the user chooses it (`biometricOnly: false`).
  Future<bool> authenticate() async {
    if (!_platformHasPlugin) return true;
    return _auth.authenticate(
      localizedReason: 'Dub を開くには本人確認が必要です',
      options: const AuthenticationOptions(
        biometricOnly: false,
        stickyAuth: true,
        useErrorDialogs: true,
      ),
    );
  }
}

const _prefsKeyEnabled = 'app_lock_enabled';

class AppLockController extends StateNotifier<LockState> {
  AppLockController(this._gate) : super(const LockState.initial()) {
    _bootstrap();
  }

  final BiometricGate _gate;

  Future<void> _bootstrap() async {
    final supported = await _gate.canAuthenticate();
    final prefs = await SharedPreferences.getInstance();
    final enabled = prefs.getBool(_prefsKeyEnabled) ?? false;

    // If the platform can't authenticate, force the gate open regardless of
    // the stored preference so the user is never locked out.
    if (!supported || !enabled) {
      state = LockState(
        phase: LockPhase.unlocked,
        enabled: enabled,
        supported: supported,
      );
      return;
    }

    state = LockState(
      phase: LockPhase.locked,
      enabled: true,
      supported: true,
    );
    // Present the prompt immediately on launch.
    await authenticate();
  }

  /// Runs the OS auth prompt; on success moves the gate to unlocked.
  Future<void> authenticate() async {
    if (state.phase == LockPhase.authenticating) return;
    state = state.copyWith(phase: LockPhase.authenticating, clearError: true);
    try {
      final ok = await _gate.authenticate();
      if (ok) {
        state = state.copyWith(phase: LockPhase.unlocked, clearError: true);
      } else {
        state = state.copyWith(
          phase: LockPhase.locked,
          error: '認証がキャンセルされました',
        );
      }
    } on Exception catch (e) {
      state = state.copyWith(
        phase: LockPhase.locked,
        error: '認証に失敗しました: $e',
      );
    }
  }

  /// Toggle the launch gate on/off (persisted).
  Future<void> setEnabled(bool value) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_prefsKeyEnabled, value);

    if (!value) {
      state = state.copyWith(enabled: false, phase: LockPhase.unlocked);
      return;
    }

    final supported = state.supported || await _gate.canAuthenticate();
    state = state.copyWith(enabled: true, supported: supported);
    // Turning it on takes effect from the next launch; we don't lock the
    // user out mid-session.
  }

  /// Re-arm the gate (e.g. bound to a future "lock now" affordance).
  void lock() {
    if (!state.enabled || !state.supported) return;
    state = state.copyWith(phase: LockPhase.locked, clearError: true);
  }
}

final biometricGateProvider = Provider<BiometricGate>((ref) => BiometricGate());

final appLockControllerProvider =
    StateNotifierProvider<AppLockController, LockState>((ref) {
  return AppLockController(ref.watch(biometricGateProvider));
});
