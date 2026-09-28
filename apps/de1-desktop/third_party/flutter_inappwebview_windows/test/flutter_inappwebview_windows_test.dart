import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_inappwebview_windows/src/in_app_webview/custom_platform_view.dart';

// Regression test for the Dub-vendored Windows scroll fix — see the
// doc comment on [dominantAxisScrollDelta] in custom_platform_view.dart and
// apps/de1-desktop/third_party/README.md for the full root-cause writeup.
//
// Upstream bug: sending a non-zero horizontal delta to WebView2 alongside a
// vertical one breaks vertical scrolling for the rest of the gesture. This
// pins the fix — exactly one axis survives per update, whichever had the
// larger magnitude, and the other is zeroed (not dropped).
void main() {
  group('dominantAxisScrollDelta', () {
    test('pure vertical input passes dy through unchanged', () {
      final result = dominantAxisScrollDelta(0, -12.5);
      expect(result.dx, 0);
      expect(result.dy, -12.5);
    });

    test('pure horizontal input passes dx through unchanged', () {
      final result = dominantAxisScrollDelta(8.0, 0);
      expect(result.dx, 8.0);
      expect(result.dy, 0);
    });

    test(
        'vertical scroll with small horizontal jitter keeps only the '
        'vertical component (the exact bug this patch fixes)', () {
      final result = dominantAxisScrollDelta(0.7, -15.0);
      expect(result.dx, 0);
      expect(result.dy, -15.0);
    });

    test('never forwards both axes as non-zero in the same update', () {
      for (final sample in [
        (3.0, 3.1),
        (-1.0, 0.5),
        (0.0, 0.0),
        (100.0, -0.01),
        (-0.01, 100.0),
      ]) {
        final result = dominantAxisScrollDelta(sample.$1, sample.$2);
        expect(
          result.dx == 0 || result.dy == 0,
          isTrue,
          reason: 'dx=${result.dx} dy=${result.dy} for input $sample',
        );
      }
    });

    test('exact tie prefers vertical (matches "dx.abs() > dy.abs()" check)',
        () {
      final result = dominantAxisScrollDelta(5.0, 5.0);
      expect(result.dx, 0);
      expect(result.dy, 5.0);
    });
  });
}
