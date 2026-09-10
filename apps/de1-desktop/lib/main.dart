import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

import 'feature_registry.dart';
import 'webview_runtime_check.dart';

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

/// How long the shell waits for the SPA to finish loading before treating it
/// as failed (shows a retry screen instead of spinning forever).
const _loadTimeout = Duration(seconds: 20);

/// Full-window WebView hosting the production Web SPA.
class WebShell extends StatefulWidget {
  const WebShell({super.key});

  @override
  State<WebShell> createState() => _WebShellState();
}

class _WebShellState extends State<WebShell> {
  /// Whether the one-time WebView-engine preflight ([_runRuntimeCheck]) is
  /// still in flight. Only relevant on Windows (see [WebRuntimeStatus]).
  bool _checkingRuntime = true;
  WebRuntimeStatus _runtimeStatus = WebRuntimeStatus.available;

  bool _loading = true;
  String? _loadError;
  Timer? _loadTimeoutTimer;

  /// The live WebView controller, captured in [InAppWebView.onWebViewCreated].
  /// Needed so the Android hardware/gesture back button can drive the WebView's
  /// own navigation history (see the [PopScope] below).
  InAppWebViewController? _controller;

  /// Bumped on every retry to force [InAppWebView] to fully remount (and thus
  /// re-issue [InAppWebView.initialUrlRequest]) rather than reusing a webview
  /// that may be stuck in a broken state.
  Key _webViewKey = UniqueKey();

  @override
  void initState() {
    super.initState();
    _runRuntimeCheck();
  }

  @override
  void dispose() {
    _loadTimeoutTimer?.cancel();
    super.dispose();
  }

  /// Probes whether this platform can actually host a WebView before we try
  /// to mount one. On Windows, a missing WebView2 Runtime otherwise causes
  /// `flutter_inappwebview` to fail *silently* (no callback ever fires), which
  /// is the root cause of the "opens and loads forever" bug this guards
  /// against. See `webview_runtime_check.dart` for the full explanation.
  Future<void> _runRuntimeCheck() async {
    setState(() => _checkingRuntime = true);
    final status = await checkWebRuntime(
      isWindows: !kIsWeb && Platform.isWindows,
      getAvailableVersion: WebViewEnvironment.getAvailableVersion,
    );
    if (!mounted) return;
    setState(() {
      _runtimeStatus = status;
      _checkingRuntime = false;
    });
    if (status == WebRuntimeStatus.available) {
      _armLoadTimeout();
    }
  }

  void _armLoadTimeout() {
    _loadTimeoutTimer?.cancel();
    _loadTimeoutTimer = Timer(_loadTimeout, () {
      if (mounted && _loading) {
        _onLoadFailed(
          '読み込みがタイムアウトしました（${_loadTimeout.inSeconds}秒）。'
          'ネットワーク接続を確認して再試行してください。',
        );
      }
    });
  }

  void _onLoadFinished() {
    _loadTimeoutTimer?.cancel();
    if (mounted) {
      setState(() {
        _loading = false;
        _loadError = null;
      });
    }
  }

  void _onLoadFailed(String message) {
    _loadTimeoutTimer?.cancel();
    if (mounted) {
      setState(() {
        _loading = false;
        _loadError = message;
      });
    }
  }

  void _retry() {
    setState(() {
      _loading = true;
      _loadError = null;
      _webViewKey = UniqueKey();
    });
    _armLoadTimeout();
  }

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
    if (_checkingRuntime) {
      // Sub-second on every platform (native probe / instant `true` on
      // non-Windows) — a bare spinner is fine here, this is not the hang.
      return const _CenteredMessage(child: CircularProgressIndicator());
    }

    if (_runtimeStatus == WebRuntimeStatus.missingOnWindows) {
      return _WebView2MissingScreen(onRetry: _runRuntimeCheck);
    }

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
                key: _webViewKey,
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
                  _onLoadFinished();
                },
                onReceivedError: (controller, request, error) {
                  // Sub-resource failures (an image, an analytics beacon, …)
                  // shouldn't blank the whole shell — only fail on the main
                  // document request.
                  if (request.isForMainFrame ?? true) {
                    _onLoadFailed('${error.type}: ${error.description}');
                  }
                },
              ),
              if (_loading && _loadError == null)
                const _CenteredMessage(
                  background: Colors.white,
                  child: CircularProgressIndicator(),
                ),
              if (_loadError != null)
                _LoadErrorScreen(message: _loadError!, onRetry: _retry),
            ],
          ),
        ),
      ),
    );
  }
}

class _CenteredMessage extends StatelessWidget {
  const _CenteredMessage({required this.child, this.background = Colors.white});

  final Widget child;
  final Color background;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(color: background, child: Center(child: child));
  }
}

/// Shown when the main SPA document failed to load (network error, timeout,
/// DNS failure, …) — replaces an infinite spinner with an actionable message
/// and a retry button, instead of hanging silently.
class _LoadErrorScreen extends StatelessWidget {
  const _LoadErrorScreen({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: Colors.white,
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.wifi_off, size: 48, color: Colors.black45),
              const SizedBox(height: 16),
              const Text(
                'Dub を読み込めませんでした',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 8),
              Text(
                message,
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.black54),
              ),
              const SizedBox(height: 24),
              FilledButton(onPressed: onRetry, child: const Text('再試行')),
            ],
          ),
        ),
      ),
    );
  }
}

/// Shown instead of a silent, permanent spinner when Windows has no WebView2
/// Runtime installed — the actual root cause of the "opens and hangs" bug.
/// `flutter_inappwebview` needs the OS-wide Evergreen WebView2 Runtime; most
/// Windows 11 machines have it preinstalled, but Windows 10 / locked-down
/// machines often do not.
class _WebView2MissingScreen extends StatelessWidget {
  const _WebView2MissingScreen({required this.onRetry});

  final VoidCallback onRetry;

  static const _downloadUrl =
      'https://developer.microsoft.com/microsoft-edge/webview2/';

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.download_for_offline_outlined,
                  size: 48, color: Colors.black45),
              const SizedBox(height: 16),
              const Text(
                'WebView2 ランタイムが必要です',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 8),
              const Text(
                'Dub デスクトップは Windows 標準の WebView2 ランタイムを使って画面を'
                '表示します。このPCには見つかりませんでした。下のURLから\n'
                '「Evergreen Bootstrapper」をインストールしてから再試行してください。'
                '（多くの Windows 11 環境には最初から入っています）',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.black54),
              ),
              const SizedBox(height: 16),
              const SelectableText(
                _downloadUrl,
                style: TextStyle(
                  color: Colors.blue,
                  decoration: TextDecoration.underline,
                ),
              ),
              const SizedBox(height: 24),
              FilledButton(
                onPressed: onRetry,
                child: const Text('インストール後に再試行'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
