// Unit tests for the native remote-push controller (Apple APNs mint + Windows WNS).
//
// The native side (AppDelegate / the C++ runner) is stubbed via a mock
// MethodChannel; the mo3 registration HTTP call is stubbed via a MockClient. We
// assert: platform gating, the correct platform+token POSTed to mo3, the
// deferred-bearer retry, and the native->Dart token-refresh path.
import 'dart:convert';

import 'package:dub_desktop/push/native_push.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('jp.developershub.dub/native_push');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  /// Make the mock native side return [token] from `registerForPush`.
  void mockNative(String? token) {
    messenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'registerForPush') return token;
      return null;
    });
  }

  /// Simulate a native->Dart `onPushToken` call (APNs refresh / WNS renew).
  Future<void> fireNativeToken(String token) async {
    await messenger.handlePlatformMessage(
      channel.name,
      const StandardMethodCodec().encodeMethodCall(
        MethodCall('onPushToken', {'token': token}),
      ),
      (_) {},
    );
  }

  tearDown(() => messenger.setMockMethodCallHandler(channel, null));

  group('mobilePlatform gating', () {
    for (final p in ['ios', 'macos', 'windows']) {
      test('$p is supported and maps to itself', () {
        final np = NativePush(platformOverride: p);
        expect(np.mobilePlatform, p);
        expect(np.isSupported, isTrue);
      });
    }

    for (final p in ['android', 'web', 'other']) {
      test('$p is not handled here (FcmPush/none)', () {
        final np = NativePush(platformOverride: p);
        expect(np.mobilePlatform, isNull);
        expect(np.isSupported, isFalse);
      });
    }
  });

  test('does nothing (no channel call, no POST) on an unsupported platform', () async {
    var invoked = false;
    messenger.setMockMethodCallHandler(channel, (call) async {
      invoked = true;
      return null;
    });
    var posted = false;
    final np = NativePush(
      platformOverride: 'android',
      channel: channel,
      httpClient: MockClient((_) async {
        posted = true;
        return http.Response('', 201);
      }),
      bearerProvider: () async => 'tok',
    );
    await np.init();
    expect(invoked, isFalse);
    expect(posted, isFalse);
  });

  for (final p in ['ios', 'macos']) {
    test('$p: mints the APNs token but does NOT register it with mo3 '
        '(mo3 sends $p via FCM; FcmPush registers the FCM token)', () async {
      var invoked = false;
      messenger.setMockMethodCallHandler(channel, (call) async {
        invoked = call.method == 'registerForPush';
        return 'apns_hex_token';
      });
      var posted = false;
      final np = NativePush(
        platformOverride: p,
        channel: channel,
        bearerProvider: () async => 'bearer_x',
        httpClient: MockClient((_) async {
          posted = true;
          return http.Response('', 201);
        }),
      );

      await np.init();
      await fireNativeToken('refreshed_token');

      expect(invoked, isTrue);
      expect(posted, isFalse);
      expect(np.hasPendingRegistration, isFalse);
    });
  }

  test('Windows: registers the WNS Channel URI with mo3 (platform windows)', () async {
    const uri = 'https://db5.notify.windows.com/?token=abc';
    mockNative(uri);
    Map<String, dynamic>? body;
    final np = NativePush(
      platformOverride: 'windows',
      channel: channel,
      bearerProvider: () async => 'bearer_w',
      httpClient: MockClient((req) async {
        body = jsonDecode(req.body) as Map<String, dynamic>;
        return http.Response('{"deviceId":"mdev_2"}', 201);
      }),
    );

    await np.init();

    expect(body, {'platform': 'windows', 'pushToken': uri});
  });

  test('defers when no bearer, then registers on retry once a bearer exists', () async {
    mockNative('tok_deferred');
    var calls = 0;
    String? bearer; // starts null (no mo3 session yet)
    final np = NativePush(
      platformOverride: 'windows',
      channel: channel,
      bearerProvider: () async => bearer,
      httpClient: MockClient((_) async {
        calls++;
        return http.Response('', 201);
      }),
    );

    await np.init();
    expect(calls, 0, reason: 'no POST without a bearer');
    expect(np.hasPendingRegistration, isTrue);

    bearer = 'bearer_late';
    await np.retryPendingRegistration();
    expect(calls, 1);
    expect(np.hasPendingRegistration, isFalse);
  });

  test('keeps the token pending when mo3 returns a non-201', () async {
    mockNative('tok');
    final np = NativePush(
      platformOverride: 'windows',
      channel: channel,
      bearerProvider: () async => 'b',
      httpClient: MockClient((_) async => http.Response('nope', 500)),
    );
    await np.init();
    expect(np.hasPendingRegistration, isTrue);
  });

  test('native->Dart onPushToken triggers a (re)registration', () async {
    mockNative(null); // no token from the initial registerForPush
    Map<String, dynamic>? body;
    final np = NativePush(
      platformOverride: 'windows',
      channel: channel,
      bearerProvider: () async => 'b',
      httpClient: MockClient((req) async {
        body = jsonDecode(req.body) as Map<String, dynamic>;
        return http.Response('', 201);
      }),
    );

    await np.init(); // installs the onPushToken handler; no POST yet
    expect(body, isNull);

    await fireNativeToken('refreshed_token');
    expect(body, {'platform': 'windows', 'pushToken': 'refreshed_token'});
  });

  test('a MissingPluginException (native handler absent) is swallowed', () async {
    // No mock handler registered -> invokeMethod throws MissingPluginException.
    messenger.setMockMethodCallHandler(channel, null);
    final np = NativePush(
      platformOverride: 'windows',
      channel: channel,
      bearerProvider: () async => 'b',
      httpClient: MockClient((_) async => http.Response('', 201)),
    );
    await expectLater(np.init(), completes);
    expect(np.hasPendingRegistration, isFalse);
  });
}
