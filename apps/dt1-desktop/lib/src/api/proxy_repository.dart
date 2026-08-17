import 'package:dio/dio.dart';

/// Raised when a proxied read fails, carrying the gateway/service error code so
/// screens can distinguish "not permitted" (FORBIDDEN) from a transient upstream
/// failure. Mirrors the `@dub/errors` wire shape ({ error: { code, message } }).
class ApiException implements Exception {
  ApiException(this.status, this.code, this.message);
  final int status;
  final String code;
  final String message;
  @override
  String toString() => message;
}

/// Thin transport for the gateway's transparent proxy — the per-service reads
/// (tasks, gantt, notifications, events) the generated typed client does not
/// cover. Every caller passes a full gateway path; query strings are built from
/// the desktop wire descriptor ([kDesktopWire]) so no key is ever hand-written
/// here. The single Dio already attaches the session bearer.
class ProxyClient {
  ProxyClient(this._dio);

  final Dio _dio;

  /// GET a proxied path and return the decoded JSON body (Map or List).
  Future<Object?> getJson(String path) async {
    final res = await _dio.get<Object?>(path);
    final status = res.statusCode ?? 0;
    if (status >= 200 && status < 300) return res.data;
    throw _errorFrom(status, res.data);
  }

  ApiException _errorFrom(int status, Object? body) {
    String code = 'UPSTREAM_ERROR';
    String message;
    if (body is Map && body['error'] is Map) {
      final err = body['error'] as Map;
      if (err['code'] is String) code = err['code'] as String;
    }
    switch (status) {
      case 401:
        message = 'セッションの有効期限が切れました。再度サインインしてください。';
        break;
      case 403:
        message = 'このデータにアクセスする権限がありません。';
        break;
      case 404:
        message = '見つかりませんでした。';
        break;
      default:
        message = '読み込みに失敗しました（$status）。';
    }
    return ApiException(status, code, message);
  }
}

/// Helpers shared by the hand-written proxy models. Keys must match the
/// service OpenAPI schemas exactly (the desktop wire test guards query keys;
/// these read-side keys follow the same discipline).
String asString(Object? v, [String fallback = '']) => v is String ? v : fallback;
int asInt(Object? v, [int fallback = 0]) => v is int ? v : (v is num ? v.toInt() : fallback);

DateTime? asDate(Object? v) {
  if (v is String && v.isNotEmpty) return DateTime.tryParse(v);
  return null;
}

List<Map<String, Object?>> asItems(Object? body) {
  if (body is Map && body['items'] is List) {
    return (body['items'] as List).whereType<Map>().map((m) => m.cast<String, Object?>()).toList();
  }
  if (body is List) {
    return body.whereType<Map>().map((m) => m.cast<String, Object?>()).toList();
  }
  return const [];
}
