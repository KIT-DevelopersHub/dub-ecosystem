//
// AUTO-GENERATED FILE, DO NOT MODIFY!
//

import 'dart:async';

import 'package:built_value/json_object.dart';
import 'package:built_value/serializer.dart';
import 'package:dio/dio.dart';

import 'package:dub_api_client/src/api_util.dart';
import 'package:dub_api_client/src/model/error.dart';

class ProxyApi {

  final Dio _dio;

  final Serializers _serializers;

  const ProxyApi(this._dio, this._serializers);

  /// Transparent proxy to a backing service
  /// Catch-all for every /api/v1/&lt;segment&gt;/_* request the gateway does not own itself. Applies to all HTTP methods (GET/POST/PUT/PATCH/DELETE) — one operation documents the shared behaviour. Resolves the route, applies guards (WebSocket-upgrade rejected as 400, body cap, internal-only sub-paths 404&#39;d), runs a one-shot session verify for auth:required segments, then forwards with x-dub-request-id + x-dub-user-id. Per-service request/response schemas live in that service&#39;s own spec. See each &lt;service&gt;.yaml.
  ///
  /// Parameters:
  /// * [segment] - First path segment selecting the backing service: auth, identity, events, actions, tasks, gantt, notifications, files, drive, chat, mail, deploy, github, audit, webhooks.
  /// * [path] - Remaining sub-path, forwarded verbatim to the service after stripping the /api/v1 prefix.
  /// * [cancelToken] - A [CancelToken] that can be used to cancel the operation
  /// * [headers] - Can be used to add additional headers to the request
  /// * [extras] - Can be used to add flags to the request
  /// * [validateStatus] - A [ValidateStatus] callback that can be used to determine request success based on the HTTP status of the response
  /// * [onSendProgress] - A [ProgressCallback] that can be used to get the send progress
  /// * [onReceiveProgress] - A [ProgressCallback] that can be used to get the receive progress
  ///
  /// Returns a [Future]
  /// Throws [DioException] if API call or serialization fails
  Future<Response<void>> proxyRequest({ 
    required String segment,
    required String path,
    CancelToken? cancelToken,
    Map<String, dynamic>? headers,
    Map<String, dynamic>? extra,
    ValidateStatus? validateStatus,
    ProgressCallback? onSendProgress,
    ProgressCallback? onReceiveProgress,
  }) async {
    final _path = r'/api/v1/{segment}/{path}'.replaceAll('{' r'segment' '}', encodeQueryParameter(_serializers, segment, const FullType(String)).toString()).replaceAll('{' r'path' '}', encodeQueryParameter(_serializers, path, const FullType(String)).toString());
    final _options = Options(
      method: r'GET',
      headers: <String, dynamic>{
        ...?headers,
      },
      extra: <String, dynamic>{
        'secure': <Map<String, String>>[
          {
            'type': 'apiKey',
            'name': 'gatewayIdentity',
            'keyName': 'x-dub-user-id',
            'where': 'header',
          },{
            'type': 'apiKey',
            'name': 'sessionCookie',
            'keyName': 'dub_session',
            'where': '',
          },
        ],
        ...?extra,
      },
      validateStatus: validateStatus,
    );

    final _response = await _dio.request<Object>(
      _path,
      options: _options,
      cancelToken: cancelToken,
      onSendProgress: onSendProgress,
      onReceiveProgress: onReceiveProgress,
    );

    return _response;
  }

}
