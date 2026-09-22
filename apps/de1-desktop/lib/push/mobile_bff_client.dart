import 'package:dio/dio.dart';

import '../config.dart';

/// Thin client over the mobile-bff (`m-api.developershub.jp`) for push-device
/// registration. Separate from [GatewayClient] because it targets a different
/// origin (the mobile face) and authenticates by carrying the `dub_session`
/// token value as a `Bearer` header.
///
/// Why Bearer and not the cookie jar: in production the session cookie is
/// host-only on `api.developershub.jp`, so it never reaches the `m-api`
/// subdomain on its own. The mobile-bff verifies the token identically whether
/// it arrives as `Authorization: Bearer <token>` or a `dub_session` cookie, so
/// we forward the value explicitly as a Bearer here.
class MobileBffClient {
  MobileBffClient(this._dio);

  final Dio _dio;

  factory MobileBffClient.create() {
    final dio = Dio(
      BaseOptions(
        baseUrl: AppConfig.mobileBffBaseUrl,
        connectTimeout: const Duration(seconds: 15),
        receiveTimeout: const Duration(seconds: 20),
        validateStatus: (_) => true,
        headers: {'accept': 'application/json'},
      ),
    );
    return MobileBffClient(dio);
  }

  String get _p => AppConfig.mobilePrefix;

  /// POST /m/v1/devices — upsert this device's push token.
  ///
  /// Idempotent by (platform, pushToken) on the server: re-registering the same
  /// token returns the same deviceId and never invalidates an existing row.
  /// Returns the server-assigned deviceId, or null on failure (push is a
  /// best-effort enhancement — a failure here must never block the app).
  Future<String?> registerDevice({
    required String sessionToken,
    required String platform,
    required String pushToken,
  }) async {
    final res = await _dio.post<Map<String, dynamic>>(
      '$_p/devices',
      data: {'platform': platform, 'pushToken': pushToken},
      options: Options(headers: {'authorization': 'Bearer $sessionToken'}),
    );
    final status = res.statusCode ?? 0;
    if (status >= 200 && status < 300) {
      return res.data?['deviceId'] as String?;
    }
    return null;
  }

  /// DELETE /m/v1/devices/:deviceId — disable this device (best-effort logout).
  Future<bool> unregisterDevice({
    required String sessionToken,
    required String deviceId,
  }) async {
    final res = await _dio.delete<dynamic>(
      '$_p/devices/$deviceId',
      options: Options(headers: {'authorization': 'Bearer $sessionToken'}),
    );
    final status = res.statusCode ?? 0;
    return status >= 200 && status < 300;
  }
}
