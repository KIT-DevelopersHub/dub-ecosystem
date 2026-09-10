// Unit tests for the biometric launch gate — the shell's only native logic.
//
// The gate must:
//   (a) always wipe the persisted WebView session on launch, so a stale fe2
//       cookie can never drop the user into the previous account,
//   (b) stay open (but *signed-out*, authenticated=false) when the device can't
//       authenticate or there are no saved credentials (first run),
//   (c) arm + unlock — and mark authenticated=true — on a successful biometric
//       prompt, or stay locked on a failed/cancelled one, and
//   (d) re-lock + re-clear the session on an explicit lock().
import 'package:dub_desktop/state/app_lock.dart';
import 'package:dub_desktop/state/credential_store.dart';
import 'package:dub_desktop/state/web_session.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeGate extends BiometricGate {
  _FakeGate({required this.supported, required this.authResult});

  final bool supported;
  final bool authResult;

  @override
  Future<bool> canAuthenticate() async => supported;

  @override
  Future<bool> authenticate() async => authResult;
}

class _FakeStore extends CredentialStore {
  _FakeStore({required this.hasCreds});

  final bool hasCreds;

  @override
  Future<bool> hasCredentials() async => hasCreds;
}

/// Records how many times the WebView session was cleared.
class _FakeSession implements WebSession {
  int clears = 0;

  @override
  Future<void> clear() async => clears++;
}

class _Harness {
  _Harness(this.container, this.session);
  final ProviderContainer container;
  final _FakeSession session;

  LockState get state => container.read(appLockControllerProvider);
  AppLockController get controller =>
      container.read(appLockControllerProvider.notifier);
}

Future<_Harness> _bootstrapped({
  required bool supported,
  required bool hasCreds,
  required bool authResult,
}) async {
  final session = _FakeSession();
  final container = ProviderContainer(overrides: [
    biometricGateProvider.overrideWithValue(
      _FakeGate(supported: supported, authResult: authResult),
    ),
    credentialStoreProvider.overrideWithValue(
      _FakeStore(hasCreds: hasCreds),
    ),
    webSessionProvider.overrideWithValue(session),
  ]);
  addTearDown(container.dispose);
  // Instantiate + keep the (lazy) provider alive so its constructor's async
  // bootstrap actually runs, then let it settle before asserting.
  container.listen(appLockControllerProvider, (_, __) {}, fireImmediately: true);
  await Future<void>.delayed(const Duration(milliseconds: 20));
  return _Harness(container, session);
}

void main() {
  test('wipes the WebView session on every launch', () async {
    final h = await _bootstrapped(
        supported: true, hasCreds: true, authResult: true);
    expect(h.session.clears, greaterThanOrEqualTo(1));
  });

  test('opens straight through when the device cannot authenticate', () async {
    final h = await _bootstrapped(
        supported: false, hasCreds: true, authResult: true);
    expect(h.state.phase, LockPhase.unlocked);
    expect(h.state.supported, isFalse);
    // Bypass path: NOT authenticated → credentials must not be auto-filled.
    expect(h.state.authenticated, isFalse);
    // The session was still cleared, so the user faces a manual login.
    expect(h.session.clears, greaterThanOrEqualTo(1));
  });

  test('opens straight through on first run (no saved credentials)', () async {
    final h = await _bootstrapped(
        supported: true, hasCreds: false, authResult: true);
    expect(h.state.phase, LockPhase.unlocked);
    expect(h.state.authenticated, isFalse);
  });

  test('unlocks + marks authenticated after a successful biometric prompt',
      () async {
    final h = await _bootstrapped(
        supported: true, hasCreds: true, authResult: true);
    expect(h.state.phase, LockPhase.unlocked);
    expect(h.state.authenticated, isTrue);
  });

  test('stays locked (not authenticated) when the prompt fails/cancels',
      () async {
    final h = await _bootstrapped(
        supported: true, hasCreds: true, authResult: false);
    expect(h.state.phase, LockPhase.locked);
    expect(h.state.authenticated, isFalse);
    expect(h.state.error, isNotNull);
  });

  test('explicit lock() re-clears the session and re-arms the gate', () async {
    final h = await _bootstrapped(
        supported: true, hasCreds: true, authResult: true);
    final clearsAfterBootstrap = h.session.clears;
    expect(h.state.phase, LockPhase.unlocked);

    await h.controller.lock();
    // Session cleared again, and (armed device) we end back unlocked via the
    // fake's successful re-auth — still authenticated.
    expect(h.session.clears, greaterThan(clearsAfterBootstrap));
    expect(h.state.phase, LockPhase.unlocked);
    expect(h.state.authenticated, isTrue);
  });
}
