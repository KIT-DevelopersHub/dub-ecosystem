import 'package:dio/dio.dart';
import 'package:dub_api_client/dub_api_client.dart';

import '../config/app_config.dart';

/// Builds the single generated gateway client for the app.
///
/// One place constructs [DubApiClient] so transport concerns (base URL, session
/// credential forwarding, correlation-id logging) live in exactly one spot.
///
/// Auth (P0 scope): desktop reuses the web/self-hosted session — it does NOT
/// implement its own auth (roadmap §7). On desktop the OS cookie jar is not
/// shared with a browser, so P1 will attach the session cookie / bearer here via
/// [sessionCredential]. For the P0 smoke this is optional and left null.
class GatewayClientFactory {
  const GatewayClientFactory(this.config);

  final AppConfig config;

  DubApiClient create({String? sessionCredential}) {
    final dio = Dio(
      BaseOptions(
        baseUrl: config.apiBaseUrl,
        connectTimeout: const Duration(seconds: 5),
        receiveTimeout: const Duration(seconds: 10),
        // Send cookies on same-site; desktop has no browser jar so P1 will set
        // the Cookie/Authorization header explicitly via the interceptor below.
        headers: const {'accept': 'application/json'},
      ),
    );

    if (sessionCredential != null && sessionCredential.isNotEmpty) {
      dio.interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) {
            // Session reuse: forward the self-hosted session cookie.
            options.headers['cookie'] = sessionCredential;
            handler.next(options);
          },
        ),
      );
    }

    // interceptors: [] disables the generated auth stubs (OAuth/Basic/Bearer/
    // ApiKey) we don't use; session handling is ours (above).
    return DubApiClient(dio: dio, interceptors: dio.interceptors.toList());
  }
}
