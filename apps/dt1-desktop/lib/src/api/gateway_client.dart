import 'package:dio/dio.dart';
import 'package:dub_api_client/dub_api_client.dart';

import '../config/app_config.dart';

/// The single transport into the api-gateway. Owns base URL, session-bearer
/// forwarding and the generated [DubApiClient] — one place so credential and
/// correlation concerns live in exactly one spot.
///
/// Auth (roadmap §7): the desktop reuses the self-hosted session. There is no
/// browser cookie jar on desktop, so after an interactive login we forward the
/// session as `Authorization: Bearer <token>` — the gateway's frozen extraction
/// order is Bearer first, then the `dub_session` cookie (services/api-gateway
/// auth.ts), so a bearer is the natural desktop credential. The token is read
/// live from [tokenProvider] on every request, so a login/logout after the
/// client is built takes effect immediately.
class Gateway {
  Gateway._(this.dio, this.api);

  /// The raw transport — used by the auth layer for the login/logout endpoints
  /// (public, proxied, not part of the generated gateway surface) and by the
  /// proxy repositories for per-service reads the gateway forwards verbatim.
  final Dio dio;

  /// The generated, OpenAPI-derived client for the gateway's OWN typed surface
  /// (`/me`, `/bff/home`, …). Never hand-write these calls.
  final DubApiClient api;

  factory Gateway.create(
    AppConfig config, {
    required String? Function() tokenProvider,
    HttpClientAdapter? adapter,
  }) {
    final dio = Dio(
      BaseOptions(
        baseUrl: config.apiBaseUrl,
        connectTimeout: const Duration(seconds: 8),
        receiveTimeout: const Duration(seconds: 15),
        headers: const {'accept': 'application/json'},
        // Never throw on non-2xx from the auth POST — we read the error body.
        validateStatus: (s) => s != null && s < 500,
      ),
    );

    dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) {
          final token = tokenProvider();
          if (token != null && token.isNotEmpty) {
            options.headers['authorization'] = 'Bearer $token';
          }
          handler.next(options);
        },
      ),
    );

    // Tests inject an in-memory adapter so the whole app can be driven without a
    // real socket (which the fake-async test clock cannot pump).
    if (adapter != null) dio.httpClientAdapter = adapter;

    final api = DubApiClient(dio: dio, interceptors: dio.interceptors.toList());
    return Gateway._(dio, api);
  }
}
