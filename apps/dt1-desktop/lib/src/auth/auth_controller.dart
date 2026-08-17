import 'package:dub_api_client/dub_api_client.dart';
import 'package:flutter/foundation.dart';

import '../features/me/me_repository.dart';
import 'auth_repository.dart';

enum AuthStatus { signedOut, authenticating, signedIn }

/// Holds desktop session state (the Bearer token + the composed `/me` identity)
/// and drives the app between the login screen and the shell. The gateway
/// client reads [token] live on every request, so signing in/out here takes
/// effect immediately without rebuilding the client.
class AuthController extends ChangeNotifier {
  AuthController({required AuthRepository authRepo, required MeRepository meRepo})
      : _authRepo = authRepo,
        _meRepo = meRepo;

  final AuthRepository _authRepo;
  final MeRepository _meRepo;

  String? _token;
  MeResponse? _me;
  AuthStatus _status = AuthStatus.signedOut;
  String? _error;

  String? get token => _token;
  MeResponse? get me => _me;
  AuthStatus get status => _status;
  String? get error => _error;
  bool get isSignedIn => _status == AuthStatus.signedIn;

  /// True iff the signed-in user holds [permission] (per-app RBAC gating — the
  /// launcher greys out apps the user cannot open, matching the web shell).
  bool can(String permission) => _me?.permissions.contains(permission) ?? false;

  Future<void> login({required String email, required String password}) async {
    _status = AuthStatus.authenticating;
    _error = null;
    notifyListeners();
    try {
      _token = await _authRepo.login(email: email, password: password);
      // With the bearer now set, compose identity + permissions from the
      // gateway's typed /me (same source the web shell uses to gate apps).
      _me = await _meRepo.fetchMe();
      _status = AuthStatus.signedIn;
    } on AuthException catch (e) {
      _token = null;
      _me = null;
      _status = AuthStatus.signedOut;
      _error = e.message;
    } catch (e) {
      _token = null;
      _me = null;
      _status = AuthStatus.signedOut;
      _error = 'ログインに失敗しました: $e';
    }
    notifyListeners();
  }

  Future<void> logout() async {
    await _authRepo.logout();
    _token = null;
    _me = null;
    _status = AuthStatus.signedOut;
    _error = null;
    notifyListeners();
  }
}
