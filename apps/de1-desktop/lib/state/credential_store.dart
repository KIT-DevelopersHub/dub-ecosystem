import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// A saved Dub login (email + password) held only in the OS secure store.
class Credentials {
  const Credentials({required this.email, required this.password});

  final String email;
  final String password;

  bool get isComplete => email.isNotEmpty && password.isNotEmpty;
}

/// At-rest storage for the one thing the native shell must remember: the
/// user's Dub credentials, so a biometric unlock can auto-fill the web login
/// form on the next launch.
///
/// Backed by the OS secure store — macOS Keychain, Windows Credential Manager
/// (DPAPI). The password is **never** written to a plain file or logged. On
/// macOS we opt out of the data-protection keychain so the store works in an
/// unsigned/dev build without a provisioning-profile keychain-access-group.
class CredentialStore {
  CredentialStore([FlutterSecureStorage? storage])
      : _storage = storage ??
            const FlutterSecureStorage(
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
              mOptions: MacOsOptions(
                useDataProtectionKeyChain: false,
                accessibility: KeychainAccessibility.first_unlock,
              ),
              iOptions: IOSOptions(
                accessibility: KeychainAccessibility.first_unlock,
              ),
            );

  final FlutterSecureStorage _storage;

  static const _kEmail = 'dub_email';
  static const _kPassword = 'dub_password';

  /// True when a full email+password pair is saved (→ launch should be
  /// biometric-gated, and the web login form can be auto-filled).
  Future<bool> hasCredentials() async {
    final c = await read();
    return c != null && c.isComplete;
  }

  /// Read the saved credentials, or null when nothing (complete) is stored.
  Future<Credentials?> read() async {
    final email = await _storage.read(key: _kEmail);
    final password = await _storage.read(key: _kPassword);
    if (email == null || password == null) return null;
    final c = Credentials(email: email, password: password);
    return c.isComplete ? c : null;
  }

  /// Persist the credentials captured from a successful manual web login.
  Future<void> save(Credentials creds) async {
    await _storage.write(key: _kEmail, value: creds.email);
    await _storage.write(key: _kPassword, value: creds.password);
  }

  /// Forget the saved credentials (e.g. bound to a future "sign out" action).
  Future<void> clear() async {
    await _storage.delete(key: _kEmail);
    await _storage.delete(key: _kPassword);
  }
}

final credentialStoreProvider =
    Provider<CredentialStore>((ref) => CredentialStore());
