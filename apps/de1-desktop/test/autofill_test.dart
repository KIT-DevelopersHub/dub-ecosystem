// Unit tests for the credential-autofill *consent* controller.
//
// The key behaviour the previous build lacked: a typed login is NOT persisted
// on submit. It is held in memory and only written to the secure store when the
// user explicitly opts in — via the post-login dialog (`enableFromPending`) or
// the settings toggle (`enable`). Declining leaves nothing saved.
import 'package:dub_desktop/state/autofill.dart';
import 'package:dub_desktop/state/credential_store.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// In-memory stand-in for the OS secure store.
class _MemStore extends CredentialStore {
  Credentials? _saved;

  @override
  Future<bool> hasCredentials() async => _saved?.isComplete ?? false;

  @override
  Future<Credentials?> read() async => _saved;

  @override
  Future<void> save(Credentials creds) async => _saved = creds;

  @override
  Future<void> clear() async => _saved = null;
}

AutofillController _controller(_MemStore store) {
  final container = ProviderContainer(overrides: [
    credentialStoreProvider.overrideWithValue(store),
  ]);
  addTearDown(container.dispose);
  return container.read(autofillControllerProvider.notifier);
}

void main() {
  test('capture holds credentials in memory without persisting them', () async {
    final store = _MemStore();
    final c = _controller(store);
    c.capture('a@b.com', 'pw');
    // Nothing is written to the store on capture.
    expect(await store.hasCredentials(), isFalse);
    // ...but we now have a pending pair to offer to save.
    expect(c.shouldPromptAfterLogin, isTrue);
  });

  test('declining a capture never persists and stops re-prompting', () async {
    final store = _MemStore();
    final c = _controller(store);
    c.capture('a@b.com', 'pw');
    c.declineThisSession();
    expect(c.shouldPromptAfterLogin, isFalse);
    expect(await store.hasCredentials(), isFalse);
  });

  test('enableFromPending persists the captured credentials (consent)', () async {
    final store = _MemStore();
    final c = _controller(store);
    c.capture('a@b.com', 'pw');
    await c.enableFromPending();
    expect(await store.hasCredentials(), isTrue);
    final saved = await store.read();
    expect(saved!.email, 'a@b.com');
    expect(saved.password, 'pw');
    // Already enabled → no longer prompts.
    expect(c.shouldPromptAfterLogin, isFalse);
  });

  test('settings enable saves pending creds when available', () async {
    final store = _MemStore();
    final c = _controller(store);
    c.capture('a@b.com', 'pw');
    final result = await c.enable();
    expect(result, EnableResult.enabled);
    expect(await store.hasCredentials(), isTrue);
  });

  test('settings enable defers to next login when nothing typed yet', () async {
    final store = _MemStore();
    final c = _controller(store);
    final result = await c.enable();
    expect(result, EnableResult.willPromptOnLogin);
    expect(await store.hasCredentials(), isFalse);
  });

  test('disable forgets saved credentials', () async {
    final store = _MemStore();
    final c = _controller(store);
    c.capture('a@b.com', 'pw');
    await c.enableFromPending();
    expect(await store.hasCredentials(), isTrue);
    await c.disable();
    expect(await store.hasCredentials(), isFalse);
  });

  test('no pending → nothing to prompt about', () async {
    final store = _MemStore();
    final c = _controller(store);
    expect(c.shouldPromptAfterLogin, isFalse);
  });
}
