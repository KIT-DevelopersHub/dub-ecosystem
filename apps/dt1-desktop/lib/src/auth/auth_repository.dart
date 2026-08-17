import 'package:dio/dio.dart';

/// Thrown when a login attempt fails, carrying the gateway's error code so the
/// UI can show the right message (invalid credentials vs domain not allowed vs
/// rate limited). Codes mirror auth-service.yaml (AUTH_INVALID_CREDENTIALS,
/// AUTH_DOMAIN_NOT_ALLOWED, RATE_LIMITED).
class AuthException implements Exception {
  AuthException(this.code, this.message);
  final String code;
  final String message;
  @override
  String toString() => message;
}

/// Talks to the interactive login endpoints. These are the gateway's PUBLIC,
/// proxied auth routes (`POST /api/v1/auth/password/login`, `/auth/logout`) —
/// they are not part of the generated typed gateway surface, so the auth layer
/// owns them directly. Request/response keys match auth-service.yaml exactly
/// (email/password → { token, session }).
class AuthRepository {
  AuthRepository(this._dio);

  final Dio _dio;

  /// `POST /api/v1/auth/password/login` → session token (Bearer credential).
  ///
  /// Access is company-domain restricted server-side; unknown-email and
  /// wrong-password are indistinguishable (401 AUTH_INVALID_CREDENTIALS).
  Future<String> login({required String email, required String password}) async {
    final res = await _dio.post<Object?>(
      '/api/v1/auth/password/login',
      data: {'email': email, 'password': password},
    );
    final status = res.statusCode ?? 0;
    final body = res.data;
    if (status == 200 && body is Map) {
      final token = body['token'];
      if (token is String && token.isNotEmpty) return token;
      throw AuthException('AUTH_NO_TOKEN', 'ログインは成功しましたが、トークンを受け取れませんでした。');
    }
    throw _errorFrom(status, body);
  }

  /// `POST /api/v1/auth/logout` — best-effort revoke; the caller clears local
  /// state regardless of the outcome.
  Future<void> logout() async {
    try {
      await _dio.post<Object?>('/api/v1/auth/logout');
    } catch (_) {
      // Ignore: the session is being discarded locally no matter what.
    }
  }

  AuthException _errorFrom(int status, Object? body) {
    String code = 'AUTH_ERROR';
    if (body is Map && body['error'] is Map) {
      final err = body['error'] as Map;
      if (err['code'] is String) code = err['code'] as String;
    }
    switch (code) {
      case 'AUTH_INVALID_CREDENTIALS':
        return AuthException(code, 'メールアドレスまたはパスワードが正しくありません。');
      case 'AUTH_DOMAIN_NOT_ALLOWED':
        return AuthException(code, 'このメールアドレスのドメインではログインできません。');
      case 'RATE_LIMITED':
        return AuthException(code, '試行回数が多すぎます。少し待ってからお試しください。');
      default:
        return AuthException(code, 'ログインに失敗しました（$status）。');
    }
  }
}
