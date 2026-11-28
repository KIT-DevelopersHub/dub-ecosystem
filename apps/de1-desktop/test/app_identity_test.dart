import 'dart:io';

import 'package:dub_desktop/app_identity.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('UA mark has the contract shape', () {
    expect(dubAppUserAgentMark(platform: 'ios'), 'DubApp/ios $kAppVersion ($kAppBuild)');
  });

  test('kAppVersion / kAppBuild match pubspec.yaml', () {
    final pubspec = File('pubspec.yaml').readAsStringSync();
    final m = RegExp(r'^version:\s*([^+\s]+)\+(\S+)', multiLine: true).firstMatch(pubspec);
    expect(m, isNotNull);
    expect(kAppVersion, m!.group(1));
    expect(kAppBuild, m.group(2));
  });
}
