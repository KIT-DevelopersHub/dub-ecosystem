import 'package:flutter/material.dart';
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Stack(
        children: [
          InAppWebView(
            initialUrlRequest: URLRequest(
              // Web app root, resolved through the registry seam. Today this is
              // the SPA root (pure 完コピ); later the shell can route individual
              // features to native views via FeatureRegistry.
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
    );
  }
}
