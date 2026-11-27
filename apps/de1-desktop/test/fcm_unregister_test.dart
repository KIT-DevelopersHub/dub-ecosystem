// FcmPush logout path: the device registered with mo3 is unregistered with
// the still-valid session, and the token is queued for the next login.
import 'dart:convert';

import 'package:dub_desktop/push/fcm_push.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  late List<http.Request> requests;
  late String? session;

  FcmPush build() => FcmPush(
        bearerProvider: () async => null,
        sessionCookieReader: () async => session,
        httpClient: MockClient((req) async {
          requests.add(req);
          if (req.method == 'POST') {
            return http.Response(jsonEncode({'deviceId': 'dev_1'}), 201);
          }
          return http.Response('', 204);
        }),
      );

  setUp(() {
    requests = [];
    session = 'sess-a';
  });

  test('registration remembers the mo3 device id', () async {
    final fcm = build();
    await fcm.debugRegister('tok');
    expect(fcm.deviceId, 'dev_1');
    expect(requests.single.headers['cookie'], 'dub_session=sess-a');
  });

  test('unregister deletes the device with the current session', () async {
    final fcm = build();
    await fcm.debugRegister('tok');
    await fcm.unregister();
    final del = requests.last;
    expect(del.method, 'DELETE');
    expect(del.url.path, '/m/v1/devices/dev_1');
    expect(del.headers['cookie'], 'dub_session=sess-a');
    expect(fcm.deviceId, isNull);
  });

  test('the next login registers the same token again', () async {
    final fcm = build();
    await fcm.debugRegister('tok');
    await fcm.unregister();
    session = 'sess-b';
    await fcm.retryPendingRegistration();
    final post = requests.last;
    expect(post.method, 'POST');
    expect(jsonDecode(post.body)['pushToken'], 'tok');
    expect(post.headers['cookie'], 'dub_session=sess-b');
  });

  test('without a registration there is nothing to delete', () async {
    final fcm = build();
    await fcm.unregister();
    expect(requests, isEmpty);
  });
}
