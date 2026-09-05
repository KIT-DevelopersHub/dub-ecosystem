// Unit tests for the biometric launch gate — the shell's only native logic.
//
// The gate must (a) stay open when the device can't authenticate or when there
// are no saved credentials to protect (first run), and (b) arm + unlock on a
// successful biometric prompt, or stay locked on a failed/cancelled one.
import 'package:dub_desktop/state/app_lock.dart';
import 'package:dub_desktop/state/credential_store.dart';
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

Future<LockState> _bootstrapped({
  required bool supported,
  required bool hasCreds,
  required bool authResult,
}) async {
  final container = ProviderContainer(overrides: [
    biometricGateProvider.overrideWithValue(
      _FakeGate(supported: supported, authResult: authResult),
    ),
    credentialStoreProvider.overrideWithValue(
      _FakeStore(hasCreds: hasCreds),
    ),
  ]);
  addTearDown(container.dispose);
  // Instantiate + keep the (lazy) provider alive so its constructor's async
  // bootstrap actually runs, then let it settle before asserting.
  container.listen(appLockControllerProvider, (_, __) {}, fireImmediately: true);
  await Future<void>.delayed(const Duration(milliseconds: 20));
  return container.read(appLockControllerProvider);
}

void main() {
  test('opens straight through when the device cannot authenticate', () async {
    final s = await _bootstrapped(
        supported: false, hasCreds: true, authResult: true);
    expect(s.phase, LockPhase.unlocked);
    expect(s.supported, isFalse);
  });

  test('opens straight through on first run (no saved credentials)', () async {
    final s = await _bootstrapped(
        supported: true, hasCreds: false, authResult: true);
    expect(s.phase, LockPhase.unlocked);
  });

  test('unlocks after a successful biometric prompt', () async {
    final s = await _bootstrapped(
        supported: true, hasCreds: true, authResult: true);
    expect(s.phase, LockPhase.unlocked);
  });

  test('stays locked when the biometric prompt fails/cancels', () async {
    final s = await _bootstrapped(
        supported: true, hasCreds: true, authResult: false);
    expect(s.phase, LockPhase.locked);
    expect(s.error, isNotNull);
  });
}
