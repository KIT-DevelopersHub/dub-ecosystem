import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dt1_desktop/src/api/gateway_client.dart';
import 'package:dt1_desktop/src/config/app_config.dart';
import 'package:dt1_desktop/src/features/me/me_repository.dart';
import 'package:flutter_test/flutter_test.dart';

/// P0 vertical-slice smoke: an in-process mock gateway serves `/api/v1/me`, and
/// the GENERATED Dart client decodes it through [MeRepository]. This is the
/// desktop end of the web→spec→Dart contract path — the same JSON the OpenAPI
/// `MeResponse` schema describes must deserialize into the generated built_value
/// model, or this test fails.
void main() {
  late HttpServer server;
  late String baseUrl;
  Map<String, String>? lastRequestHeaders;

  setUp(() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    baseUrl = 'http://127.0.0.1:${server.port}';
    unawaited(_serve(server, (req) => lastRequestHeaders = {
          for (final h in ['accept', 'cookie'])
            if (req.headers.value(h) != null) h: req.headers.value(h)!,
        }));
  });

  tearDown(() async {
    await server.close(force: true);
  });

  test('generated client fetches and decodes /me', () async {
    final repo = MeRepository(
      GatewayClientFactory(AppConfig(apiBaseUrl: baseUrl)).create(),
    );

    final me = await repo.fetchMe();

    expect(me.user.id, 'usr_123');
    expect(me.user.displayName, 'Kotaro Takaoka');
    expect(me.orgId, 'org_devhub');
    expect(me.permissions, containsAll(<String>['event:read', 'task:write']));
    expect(me.sessionExpiresAt, 1893456000000);
  });

  test('session credential is forwarded as a cookie header', () async {
    final repo = MeRepository(
      GatewayClientFactory(AppConfig(apiBaseUrl: baseUrl))
          .create(sessionCredential: 'dub_session=abc'),
    );

    await repo.fetchMe();

    expect(lastRequestHeaders?['cookie'], 'dub_session=abc');
  });
}

Future<void> _serve(HttpServer server, void Function(HttpRequest) onRequest) async {
  await for (final req in server) {
    onRequest(req);
    if (req.uri.path == '/api/v1/me') {
      req.response
        ..statusCode = 200
        ..headers.contentType = ContentType.json
        ..write(jsonEncode(<String, dynamic>{
          'user': {
            'id': 'usr_123',
            'displayName': 'Kotaro Takaoka',
            'avatarUrl': null,
          },
          'orgId': 'org_devhub',
          'permissions': ['event:read', 'task:write'],
          'sessionExpiresAt': 1893456000000,
        }));
    } else {
      req.response.statusCode = 404;
    }
    await req.response.close();
  }
}
