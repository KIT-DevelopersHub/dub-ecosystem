import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

import 'feature_registry.dart';

/// Dub desktop — a thin native shell that renders the real Web SPA.
///
/// Today there is intentionally **no bespoke Flutter UI**: the whole window is a
/// full-bleed WebView pointed at [AppConfig.webBaseUrl]. This makes the desktop
/// app a literal copy of the web app (same login, same 9-dot launcher, same
/// screens, same button positions) and it follows every web deploy for free.
/// The session cookie (`dub_session`) lives in the WebView's cookie store
/// exactly as it would in a browser.
///
/// The shell is deliberately built for **incremental native-ization**: routing
/// goes through [FeatureRegistry], which today maps every feature to the WebView
/// but is the single seam where a feature can later be swapped to a native
/// Flutter widget, one screen at a time, without touching the rest. See
/// `docs/desktop-flutter/ARCHITECTURE.md`.
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const DubDesktopApp());
}

class DubDesktopApp extends StatelessWidget {
  const DubDesktopApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      title: 'Dub',
      debugShowCheckedModeBanner: false,
      home: WebShell(),
    );
  }
}

/// Full-window WebView hosting the production Web SPA.
class WebShell extends StatefulWidget {
  const WebShell({super.key});

  @override
  State<WebShell> createState() => _WebShellState();
}

class _WebShellState extends State<WebShell> {
  bool _loading = true;

  /// The live WebView controller, captured in [InAppWebView.onWebViewCreated].
  /// Needed so the Android hardware/gesture back button can drive the WebView's
  /// own navigation history (see the [PopScope] below).
  InAppWebViewController? _controller;

  /// Handle an Android back gesture/button that the framework did *not* pop.
  ///
  /// Browser-parity: if the WebView has back history, go back inside the SPA
  /// (like a browser's back button); otherwise let the app exit.
  Future<void> _onPopInvoked(bool didPop, Object? result) async {
    if (didPop) return; // Framework already handled it (e.g. a Flutter route).
    final controller = _controller;
    if (controller != null && await controller.canGoBack()) {
      await controller.goBack();
      return;
    }
    // No web history left → close the app, matching browser/OS expectations.
    await SystemNavigator.pop();
  }

  @override
  Widget build(BuildContext context) {
    // #4: intercept the Android back button/gesture. canPop:false so every
    // back event reaches [_onPopInvoked], which decides WebView-back vs exit.
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: _onPopInvoked,
      child: Scaffold(
        // #1: SafeArea keeps the WebView clear of the status bar, notch and
        // gesture/navigation insets so the web UI never hides under system bars.
        body: SafeArea(
          child: Stack(
            children: [
              InAppWebView(
                initialUrlRequest: URLRequest(
                  // Web app root, resolved through the registry seam. Today this
                  // is the SPA root (pure 完コピ); later the shell can route
                  // individual features to native views via FeatureRegistry.
                  url: WebUri(FeatureRegistry.entryUrl()),
                ),
                initialSettings: InAppWebViewSettings(
                  // Browser-parity: keep cookies/session across launches, allow
                  // the SPA's normal cross-origin API calls, and let it open the
                  // way it does in a real browser.
                  transparentBackground: false,
                  javaScriptEnabled: true,
                  javaScriptCanOpenWindowsAutomatically: true,
                  supportZoom: false,
                  // Desktop UA so the web app renders its desktop layout, not a
                  // mobile one.
                  applicationNameForUserAgent: 'Dub-Desktop',
                ),
                onWebViewCreated: (controller) {
                  _controller = controller;
                },
                onLoadStop: (controller, url) {
                  if (mounted) setState(() => _loading = false);
                },
                onReceivedError: (controller, request, error) {
                  if (mounted) setState(() => _loading = false);
                },
              ),
              if (_loading)
                const ColoredBox(
                  color: Colors.white,
                  child: Center(child: CircularProgressIndicator()),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
