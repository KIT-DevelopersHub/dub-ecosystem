import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'credential_store.dart';

/// Outcome of turning the autofill toggle *on* from the settings surface.
enum EnableResult {
  /// Autofill was already on — nothing to do.
  alreadyEnabled,

  /// Credentials typed earlier this session were saved → armed for next launch.
  enabled,

  /// No credentials are available yet (the user hasn't typed a login this
  /// session); the enable dialog will appear the next time they sign in.
  willPromptOnLogin,
}

/// UI-facing snapshot of the credential-autofill feature.
@immutable
class AutofillState {
  const AutofillState({required this.enabled, required this.hasPending});

  const AutofillState.initial() : enabled = false, hasPending = false;

  /// True when a credential pair is saved in the OS secure store — i.e. the
  /// biometric launch gate will arm and the web login form will be auto-filled
  /// from the *next* launch on.
  final bool enabled;

  /// True when the user typed a login this session, so we hold the pair in
  /// memory and can enable autofill immediately (no re-login needed).
  final bool hasPending;

  AutofillState copyWith({bool? enabled, bool? hasPending}) => AutofillState(
        enabled: enabled ?? this.enabled,
        hasPending: hasPending ?? this.hasPending,
      );
}

/// Owns the *consent* around credential autofill — the piece the previous build
/// was missing. Capturing a typed login no longer silently persists it; instead
/// the credentials are held in memory ([_pending]) until the user explicitly
/// opts in (via the post-login "enable Touch ID?" dialog or the settings
/// toggle). Only then are they written to the OS secure store, which is what
/// arms the biometric launch gate + web-form auto-fill on the next launch.
class AutofillController extends StateNotifier<AutofillState> {
  AutofillController(this._store) : super(const AutofillState.initial()) {
    _init();
  }

  final CredentialStore _store;

  /// Credentials typed this session, held only in memory until the user
  /// consents to saving them. Never written anywhere until [enableFromPending]
  /// / [enable] runs.
  Credentials? _pending;

  /// The user chose "今はしない" this session → don't nag again until relaunch.
  bool _declinedThisSession = false;

  /// Set once the user has made an explicit enable/disable choice, so the async
  /// initial load can never clobber a fresh decision (init/action ordering race).
  bool _decided = false;

  Future<void> _init() async {
    final has = await _store.hasCredentials();
    if (mounted && !_decided) state = state.copyWith(enabled: has);
  }

  /// Hold the credentials the user just typed into the web login form. Called
  /// on form submit; nothing is persisted yet.
  void capture(String email, String password) {
    if (email.isEmpty || password.isEmpty) return;
    _pending = Credentials(email: email, password: password);
    state = state.copyWith(hasPending: true);
  }

  /// Whether the post-login "enable Touch ID?" dialog should be shown: autofill
  /// isn't on yet, we have a freshly typed login to offer to save, and the user
  /// hasn't already declined this session.
  bool get shouldPromptAfterLogin =>
      !state.enabled && _pending != null && !_declinedThisSession;

  /// User accepted the post-login dialog → persist the pending credentials and
  /// arm the gate for next launch.
  Future<void> enableFromPending() async {
    final pending = _pending;
    if (pending == null) return;
    _decided = true;
    await _store.save(pending);
    state = state.copyWith(enabled: true);
  }

  /// User dismissed the post-login dialog with "今はしない".
  void declineThisSession() => _declinedThisSession = true;

  /// Settings toggle → ON. Saves the pending credentials when available,
  /// otherwise defers to the next login. Returns what happened for UI messaging.
  Future<EnableResult> enable() async {
    _declinedThisSession = false;
    if (state.enabled) return EnableResult.alreadyEnabled;
    final pending = _pending;
    if (pending != null) {
      _decided = true;
      await _store.save(pending);
      state = state.copyWith(enabled: true);
      return EnableResult.enabled;
    }
    return EnableResult.willPromptOnLogin;
  }

  /// Settings toggle → OFF. Forgets the saved credentials so the next launch is
  /// a plain manual login again.
  Future<void> disable() async {
    _decided = true;
    await _store.clear();
    _pending = null;
    _declinedThisSession = false;
    state = state.copyWith(enabled: false, hasPending: false);
  }
}

final autofillControllerProvider =
    StateNotifierProvider<AutofillController, AutofillState>((ref) {
  return AutofillController(ref.watch(credentialStoreProvider));
});
