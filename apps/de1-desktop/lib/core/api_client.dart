import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/models.dart';
import '../config.dart';
import '../state/auth.dart';

/// Shared, feature-agnostic HTTP surface over the gateway Dio.
///
/// Every feature module issues its API calls through this — it never adds
/// methods to one giant client. That keeps parallel feature work off a shared
/// client file: a new feature ships its own `<feature>_api.dart` that wraps
/// this. Session cookies flow automatically because we reuse the one Dio the
/// [GatewayClient] configured (CookieManager + baseUrl).
class ApiClient {
  ApiClient(this._dio);

  final Dio _dio;

  /// `/api/v1` — the single public prefix on the gateway.
  String get apiPrefix => AppConfig.apiPrefix;

  /// GET returning a JSON object body.
  Future<Map<String, dynamic>> getJson(
    String path, {
    Map<String, dynamic>? query,
  }) async {
    final res = await _dio.get<Map<String, dynamic>>(
      '$apiPrefix$path',
      queryParameters: query,
    );
    _throwIfError(res);
    return res.data ?? const {};
  }

  /// GET returning a top-level JSON array body (e.g. members, pins).
  Future<List<dynamic>> getList(
    String path, {
    Map<String, dynamic>? query,
  }) async {
    final res = await _dio.get<List<dynamic>>(
      '$apiPrefix$path',
      queryParameters: query,
    );
    _throwIfError(res);
    return res.data ?? const [];
  }

  /// POST returning a JSON object body.
  Future<Map<String, dynamic>> postJson(
    String path, {
    Object? body,
  }) async {
    final res = await _dio.post<Map<String, dynamic>>(
      '$apiPrefix$path',
      data: body,
    );
    _throwIfError(res);
    return res.data ?? const {};
  }

  void _throwIfError(Response<dynamic> res) {
    final status = res.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      throw DubApiException.fromResponse(res.data, statusCode: status);
    }
  }
}

/// The shared client, ready once the session Dio exists. Feature API providers
/// depend on this (not on [GatewayClient] directly).
final apiClientProvider = FutureProvider<ApiClient>((ref) async {
  final gateway = await ref.watch(gatewayClientProvider.future);
  return ApiClient(gateway.dio);
});
