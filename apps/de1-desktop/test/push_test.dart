// Unit tests for the push client's pure logic (no native/Firebase calls).
import 'package:dub_desktop/push/push_platform.dart';
import 'package:dub_desktop/push/push_service.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('PushTap.fromData', () {
    test('extracts url / resourceType / resourceId', () {
      final tap = PushTap.fromData({
        'url': '/notifications',
        'resourceType': 'task',
        'resourceId': 'tsk_1',
      });
      expect(tap.url, '/notifications');
      expect(tap.resourceType, 'task');
      expect(tap.resourceId, 'tsk_1');
      expect(tap.isEmpty, isFalse);
    });

    test('isEmpty when payload carries no deep-link keys', () {
      final tap = PushTap.fromData({'unrelated': 'x'});
      expect(tap.isEmpty, isTrue);
    });
  });

  test('currentPushPlatform maps host OS to a valid MobilePlatform string', () {
    final p = currentPushPlatform();
    // Windows/other -> null (FCM unsupported); everything else is a value the
    // mobile-bff /m/v1/devices contract accepts.
    expect(p == null || const {'ios', 'android', 'macos'}.contains(p), isTrue);
    expect(isFcmSupportedPlatform, p != null);
  });
}
