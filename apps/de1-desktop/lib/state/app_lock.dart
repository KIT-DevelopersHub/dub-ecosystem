import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:local_auth/local_auth.dart';

import 'credential_store.dart';

/// Device-level launch gate backed by the OS biometric stack (Touch ID on
/// macOS, Windows Hello on Windows, with a passcode/password fallback).
///
/// This is the *entire* native purpose of the desktop shell: everything else is
/// the real Web SPA in a WebView. Passing this gate is what authorises the shell
/// to auto-fill the saved Dub credentials into the web login form.
///
/// The gate only arms itself when there is something to protect — i.e. when a
/// credential pair has already been saved (see [CredentialStore]). On the very
/// first launch (no saved credentials) the app opens straight to the web login
/// so the user can sign in by hand; that manual login is captured and saved,
/// and from the *next* launch on the biometric gate stands in front.
enum LockPhase {
  /// Still probing platform support / whether credentials exist.
  initializing,

  /// Gate disabled/unsupported, or already passed this launch → app is open.
  unlocked,

  /// Gate armed and not yet passed this launch.
  locked,

  /// A biometric/passcode prompt is currently on screen.
  authenticating,
}

@immutable
class LockState {
  const LockState({
    required this.phase,
    required this.supported,
    this.error,
  });

  const LockState.initial()
      : phase = LockPhase.initializing,
        supported = false,
        error = null;

  final LockPhase phase;

  /// Whether this device can authenticate the user by *some* means (biometric
  /// or device passcode). When false the gate is a no-op so the user is never
  /// locked out of their own app.
  final bool supported;

  final String? error;

  bool get isLocked => phase == LockPhase.locked;

  LockState copyWith({
    LockPhase? phase,
    bool? supported,
    String? error,
    bool clearError = false,
  }) {
    return LockState(
      phase: phase ?? this.phase,
      supported: supported ?? this.supported,
      error: clearError ? null : (error ?? this.error),
    );
  }
}

/// Thin seam over [LocalAuthentication] so the controller stays testable and so
/// we can no-op on platforms without a biometric implementation.
class BiometricGate {
  BiometricGate([LocalAuthentication? auth])
      : _auth = auth ?? LocalAuthentication();

  final LocalAuthentication _auth;

  bool get _platformHasPlugin =>
      !kIsWeb &&
      (Platform.isMacOS ||
          Platform.isWindows ||
          Platform.isIOS ||
          Platform.isAndroid);

  /// True when the device can authenticate the user by some means — biometrics
  /// if enrolled, otherwise the device passcode/password.
  Future<bool> canAuthenticate() async {
    if (!_platformHasPlugin) return false;
    try {
      return await _auth.isDeviceSupported();
    } on Exception {
      return false;
    }
  }

  /// Prompts the OS authentication UI. Returns true only on a confirmed match.
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

class AppLockController extends StateNotifier<LockState> {
  AppLockController(this._gate, this._store) : super(const LockState.initial()) {
    _bootstrap();
  }

  final BiometricGate _gate;
  final CredentialStore _store;

  Future<void> _bootstrap() async {
    final supported = await _gate.canAuthenticate();
    final hasCreds = await _store.hasCredentials();

    // Arm the gate only when we can authenticate AND there are saved
    // credentials worth protecting. Otherwise open straight through (first-run
    // manual login, or a device that can't authenticate).
    if (!supported || !hasCreds) {
      state = LockState(phase: LockPhase.unlocked, supported: supported);
      return;
    }

    state = LockState(phase: LockPhase.locked, supported: true);
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
}

final biometricGateProvider = Provider<BiometricGate>((ref) => BiometricGate());

final appLockControllerProvider =
    StateNotifierProvider<AppLockController, LockState>((ref) {
  return AppLockController(
    ref.watch(biometricGateProvider),
    ref.watch(credentialStoreProvider),
  );
});
