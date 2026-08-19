import 'dart:io';

import 'package:cookie_jar/cookie_jar.dart';
import 'package:dio/dio.dart';
import 'package:dio_cookie_manager/dio_cookie_manager.dart';

import '../config.dart';
import 'models.dart';

/// Thin client over the shared api-gateway. Web-parity auth: the auth-service
/// login response sets `Set-Cookie: dub_session=...`, the [CookieManager]
/// captures it into a persistent jar, and every subsequent gateway request
/// carries it automatically — exactly like a browser. No bearer-token plumbing,
/// no assumption about token/cookie equivalence.
class GatewayClient {
  GatewayClient._(this._dio, this._jar);

  final Dio _dio;
  final PersistCookieJar _jar;

  static Future<GatewayClient> create() async {
    final jar = PersistCookieJar(storage: FileStorage(_cookieDir()));
    final dio = Dio(
      BaseOptions(
        baseUrl: AppConfig.gatewayBaseUrl,
        connectTimeout: const Duration(seconds: 15),
        receiveTimeout: const Duration(seconds: 20),
        // We inspect non-2xx bodies ourselves to map the @dub/errors envelope.
        validateStatus: (_) => true,
        headers: {'accept': 'application/json'},
      ),
    );
    dio.interceptors.add(CookieManager(jar));
    return GatewayClient._(dio, jar);
  }

  /// Persistent cookie store location. Uses the OS home dir (HOME on
  /// macOS/Linux, USERPROFILE on Windows), falling back to a temp dir.
  /// Production should swap this for path_provider's applicationSupport dir.
  static String _cookieDir() {
    final env = Platform.environment;
    final home = env['HOME'] ?? env['USERPROFILE'] ?? Directory.systemTemp.path;
    final dir = Directory('$home/.dub_desktop/cookies');
    dir.createSync(recursive: true);
    return dir.path;
  }

  String get _p => AppConfig.apiPrefix;

  /// POST /api/v1/auth/password/login — company email + password.
  Future<TokenSessionResponse> login(String email, String password) async {
    final res = await _dio.post<Map<String, dynamic>>(
      '$_p/auth/password/login',
      data: {'email': email, 'password': password},
    );
    _throwIfError(res);
    return TokenSessionResponse.fromJson(res.data!);
  }

  /// GET /api/v1/me — current user, org, permissions, session expiry.
  Future<MeResponse> me() async {
    final res = await _dio.get<Map<String, dynamic>>('$_p/me');
    _throwIfError(res);
    return MeResponse.fromJson(res.data!);
  }

  /// GET /api/v1/notifications/inbox — the caller's notification inbox.
  Future<PaginatedInbox> inbox({int limit = 50, bool unreadOnly = false}) async {
    final res = await _dio.get<Map<String, dynamic>>(
      '$_p/notifications/inbox',
      queryParameters: {
        'limit': limit,
        if (unreadOnly) 'unreadOnly': true,
      },
    );
    _throwIfError(res);
    return PaginatedInbox.fromJson(res.data!);
  }

  /// Generic authenticated GET returning the decoded JSON object. Feature
  /// modules (e.g. roster) call this with a gateway-relative path (leading
  /// slash, without the `/api/v1` prefix) and parse the body into their own
  /// contract models, so this shared client stays free of feature-specific
  /// types. Non-2xx bodies are mapped to [DubApiException].
  Future<Map<String, dynamic>> getJson(
    String path, {
    Map<String, dynamic>? query,
  }) async {
    final res = await _dio.get<Map<String, dynamic>>(
      '$_p$path',
      queryParameters: query,
    );
    _throwIfError(res);
    return res.data ?? const <String, dynamic>{};
  }

  /// POST /api/v1/auth/logout — revoke the current session and clear cookies.
  Future<void> logout() async {
    try {
      await _dio.post('$_p/auth/logout');
    } finally {
      await _jar.deleteAll();
    }
  }

  void _throwIfError(Response<dynamic> res) {
    final status = res.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      throw DubApiException.fromResponse(res.data, statusCode: status);
    }
  }
}
