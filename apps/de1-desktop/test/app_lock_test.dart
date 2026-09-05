// Unit tests for the biometric app-lock (launch gate) controller.
import 'package:dub_desktop/state/app_lock.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Deterministic fake for the OS biometric stack.
class _FakeGate extends BiometricGate {
  _FakeGate({required this.supported, required this.willSucceed});

  final bool supported;
  final bool willSucceed;
  int authCalls = 0;

  @override
  Future<bool> canAuthenticate() async => supported;

  @override
  Future<bool> authenticate() async {
    authCalls++;
    return willSucceed;
  }
}

ProviderContainer _container(_FakeGate gate) {
  return ProviderContainer(
    overrides: [biometricGateProvider.overrideWithValue(gate)],
  );
}

/// Pumps microtasks until the controller settles out of initializing.
Future<void> _settle(ProviderContainer c) async {
  for (var i = 0; i < 10; i++) {
    await Future<void>.delayed(Duration.zero);
    if (c.read(appLockControllerProvider).phase != LockPhase.initializing) {
      break;
    }
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('unsupported device is never locked, even if enabled was persisted',
      () async {
    SharedPreferences.setMockInitialValues({'app_lock_enabled': true});
    final gate = _FakeGate(supported: false, willSucceed: true);
    final c = _container(gate);
    addTearDown(c.dispose);

    await _settle(c);
    final s = c.read(appLockControllerProvider);
    expect(s.phase, LockPhase.unlocked);
    expect(s.supported, isFalse);
    // No prompt should have been shown on an unsupported device.
    expect(gate.authCalls, 0);
  });

  test('disabled preference means the gate is open on a supported device',
      () async {
    SharedPreferences.setMockInitialValues({'app_lock_enabled': false});
    final gate = _FakeGate(supported: true, willSucceed: true);
    final c = _container(gate);
    addTearDown(c.dispose);

    await _settle(c);
    expect(c.read(appLockControllerProvider).phase, LockPhase.unlocked);
    expect(gate.authCalls, 0);
  });

  test('enabled + supported locks on launch and unlocks on success', () async {
    SharedPreferences.setMockInitialValues({'app_lock_enabled': true});
    final gate = _FakeGate(supported: true, willSucceed: true);
    final c = _container(gate);
    addTearDown(c.dispose);

    await _settle(c);
    // Bootstrap immediately fires authenticate(); with success it unlocks.
    await Future<void>.delayed(Duration.zero);
    expect(gate.authCalls, greaterThanOrEqualTo(1));
    expect(c.read(appLockControllerProvider).phase, LockPhase.unlocked);
  });

  test('failed authentication keeps the gate locked with an error', () async {
    SharedPreferences.setMockInitialValues({'app_lock_enabled': true});
    final gate = _FakeGate(supported: true, willSucceed: false);
    final c = _container(gate);
    addTearDown(c.dispose);

    await _settle(c);
    await Future<void>.delayed(Duration.zero);
    final s = c.read(appLockControllerProvider);
    expect(s.phase, LockPhase.locked);
    expect(s.error, isNotNull);
  });

  test('setEnabled(false) opens the gate and persists', () async {
    SharedPreferences.setMockInitialValues({'app_lock_enabled': true});
    final gate = _FakeGate(supported: true, willSucceed: false);
    final c = _container(gate);
    addTearDown(c.dispose);

    await _settle(c);
    await c.read(appLockControllerProvider.notifier).setEnabled(false);
    final s = c.read(appLockControllerProvider);
    expect(s.enabled, isFalse);
    expect(s.phase, LockPhase.unlocked);

    final prefs = await SharedPreferences.getInstance();
    expect(prefs.getBool('app_lock_enabled'), isFalse);
  });
}
