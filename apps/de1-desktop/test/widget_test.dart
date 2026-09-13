// Smoke tests for the Dub desktop shell.
//
// The shell is a thin native wrapper whose only job is to render the real Web
// SPA in a WebView, so there is no bespoke UI to unit-test. We assert the one
// piece of pure Dart config the shell relies on: a non-empty, https web origin
// to load. (WebView rendering itself is exercised by building/running the app.)
import 'package:flutter_test/flutter_test.dart';

import 'package:dub_desktop/config.dart';

void main() {
  test('web base URL is a concrete https origin, not the unrouted custom domain',
      () {
    expect(AppConfig.webBaseUrl, isNotEmpty);
    expect(AppConfig.webBaseUrl, startsWith('https://'));
    // api.developershub.jp is not DNS-configured and must never be the default.
    expect(AppConfig.webBaseUrl, isNot(contains('api.developershub.jp')));
  });
}
