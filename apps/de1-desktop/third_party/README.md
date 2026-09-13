# third_party/flutter_inappwebview_windows — vendored patch

## Why this exists

Users reported that vertical scrolling inside the Windows desktop app "doesn't
work in a lot of places". Root cause: an upstream bug in
`flutter_inappwebview_windows` 0.6.0 (the latest stable release as of this
writing — the fix is not in any released version, only in unmerged community
forks).

`flutter_inappwebview` renders the WebView2 surface as a Flutter `Texture`
and forwards mouse-wheel / trackpad-pan input to WebView2 itself via
`ICoreWebView2CompositionController.SendMouseInput` (see
`windows/in_app_webview/in_app_webview.cpp`, `setScrollDelta`/`sendScroll`).
The Dart side (`lib/src/in_app_webview/custom_platform_view.dart`,
`onPointerSignal` / `onPointerPanZoomUpdate`) forwarded the raw horizontal
*and* vertical delta for every wheel/pan update, unconditionally.

Confirmed upstream (root-caused by another user reading this exact code,
see https://github.com/pichillilorenzo/flutter_inappwebview/issues/2511):
sending SendMouseInput a non-zero horizontal delta alongside a vertical one
breaks vertical scrolling for the rest of that scroll session. Windows
trackpad two-finger scrolling almost always carries a small amount of
horizontal jitter even during an intentionally-vertical scroll, so this
fires constantly and intermittently — matching the "many places" symptom
(a plain external mouse wheel, which has no horizontal component, is
unaffected — this is a trackpad-specific bug). See also
https://github.com/pichillilorenzo/flutter_inappwebview/issues/2503.

Ruled out (do not re-investigate these — checked against the plugin's
Windows C++/Dart source directly):
- `gestureRecognizers` / Flutter's gesture arena: the plugin forwards wheel
  and trackpad-pan input through a raw `Listener` (`onPointerSignal`,
  `onPointerPanZoomUpdate`), which is delivered outside the gesture arena.
  `gestureRecognizers` on `InAppWebView` has no effect on this path.
- `InAppWebViewSettings.disableVerticalScroll` /
  `verticalScrollBarEnabled`: not implemented at all in the Windows native
  plugin (`in_app_webview_settings.cpp`/`.h`) — Android-only settings.
- Upgrading `flutter_inappwebview`: 6.1.5 (pinned in `pubspec.yaml`) already
  resolves the latest stable `flutter_inappwebview_windows` (0.6.0). The
  0.7.0 line that exists on pub.dev is beta-only and its changelog does not
  mention this bug.

## The fix

`lib/src/in_app_webview/custom_platform_view.dart` now routes both handlers
through a new pure function, `dominantAxisScrollDelta(dx, dy)`: whichever
axis has the larger magnitude for a given update is forwarded, the other is
zeroed. A pure vertical or pure horizontal gesture is untouched; a gesture
that is vertical-with-jitter (the common case) now always sends `dx: 0` and
never trips the underlying WebView2 bug.

Covered by `test/flutter_inappwebview_windows_test.dart` in this vendored
copy.

## How it's wired in

`apps/de1-desktop/pubspec.yaml` has:

```yaml
dependency_overrides:
  flutter_inappwebview_windows:
    path: third_party/flutter_inappwebview_windows
```

This is a full vendored copy of the real
`flutter_inappwebview_windows-0.6.0` package (from pub.dev), with only the
one Dart file above modified. Everything else — including all native
Windows C++ build files — is untouched. CI's Windows job already does a
sparse-checkout of `apps/de1-desktop/**`, so this directory is included
automatically; no workflow changes were needed.

## Maintenance note

When `flutter_inappwebview`/`flutter_inappwebview_windows` eventually ships
an upstream fix for this (tracked in the two issues linked above), delete
this `third_party/` directory and the `dependency_overrides` entry, and bump
`flutter_inappwebview` to the fixed version instead.

## Caveat — not verified on real Windows hardware

This fix is grounded in the plugin's actual native/Dart source and in a
root-cause analysis independently reproduced by another user against this
exact code path (see the GitHub issues above), but it has only been
exercised via `dart test` on the pure decision function and `flutter
analyze`/CI build in this repo — there is no Windows machine available here
to click-test real trackpad scrolling in the built `.exe`. Please confirm
scrolling behaves correctly in the rebuilt installer before treating this as
fully closed.
