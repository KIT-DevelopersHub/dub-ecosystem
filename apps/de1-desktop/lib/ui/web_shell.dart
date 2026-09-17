import 'dart:async';
import 'dart:collection';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:local_auth/local_auth.dart';

import '../feature_registry.dart';
import '../state/autofill.dart';
import '../state/credential_store.dart';
import '../webview_runtime_check.dart';

/// How long the shell waits for the SPA to finish loading before treating it
/// as failed (shows a retry screen instead of spinning forever).
const _loadTimeout = Duration(seconds: 20);

/// Full-window WebView hosting the production Web SPA (fe2-app-shell).
///
/// The window is a literal copy of the web app — same login, same 9-dot
/// launcher, same screens. The *only* native behaviour layered on top is
/// **opt-in credential autofill**:
///
///   1. On the very first launch there are no saved credentials, so the app
///      opens straight to the web login and the person signs in by hand.
///   2. The typed credentials are captured in memory (never yet persisted).
///   3. When that manual login **succeeds** (the login form unmounts), a native
///      "Face ID でログインを自動化しますか？" dialog appears (wording adapts
///      per platform — Touch ID on macOS, Windows Hello on Windows). Only if
///      the user taps 有効にする are the credentials written to the OS secure
///      store, which arms the biometric launch gate + auto-fill for the next
///      launch.
///   4. A bottom-left settings button lets the user toggle the feature on/off
///      afterwards.
///
/// Three JS bridges connect the injected page script to the native layer:
///   - `getCredentials`   → saved `{email, password}` so the script can fill
///                          (and submit) the web login form.
///   - `captureCredentials` → the just-typed login, held in memory pending
///                          consent.
///   - `loginSucceeded`   → the login form unmounted (auth succeeded), which is
///                          when we offer to enable autofill.
///
/// The password only ever lives in the WebView JS context (exactly as a browser
/// password manager would fill it) and — after explicit consent — in the OS
/// Keychain/Credential Manager. It is never written to a file or a log.
///
/// Everything else (Windows WebView2 preflight, load timeout/retry, Android
/// back-button, SafeArea) is unchanged from the plain 完コピ shell — this class
/// only adds the autofill layer on top.
class WebShell extends ConsumerStatefulWidget {
  const WebShell({super.key});

  @override
  ConsumerState<WebShell> createState() => _WebShellState();
}

class _WebShellState extends ConsumerState<WebShell> {
  /// Whether the one-time WebView-engine preflight ([_runRuntimeCheck]) is
  /// still in flight. Only relevant on Windows (see [WebRuntimeStatus]).
  bool _checkingRuntime = true;
  WebRuntimeStatus _runtimeStatus = WebRuntimeStatus.available;

  /// Windows-only: an explicit WebView2 environment pointed at a guaranteed-
  /// writable user data folder (see [resolveWindowsUserDataFolder] for why
  /// this is required). `null` on every other platform, where `InAppWebView`
  /// manages its own environment.
  WebViewEnvironment? _webViewEnvironment;

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

  /// Which native overlay (if any) is currently shown on top of the WebView.
  _Overlay _overlay = _Overlay.none;

  /// OS-appropriate name for the biometric method, used in copy. Resolved once
  /// via `local_auth` on iOS/macOS (Face ID vs Touch ID depend on the actual
  /// hardware); a static fallback everywhere else.
  String _biometricName = 'Touch ID';

  @override
  void initState() {
    super.initState();
    _resolveBiometricName();
    _runRuntimeCheck();
  }

  @override
  void dispose() {
    _loadTimeoutTimer?.cancel();
    super.dispose();
  }

  Future<void> _resolveBiometricName() async {
    if (kIsWeb) return;
    if (!(Platform.isMacOS || Platform.isIOS)) {
      if (Platform.isWindows && mounted) {
        setState(() => _biometricName = 'Windows Hello');
      } else if (Platform.isAndroid && mounted) {
        setState(() => _biometricName = '生体認証');
      }
      return;
    }
    try {
      final types = await LocalAuthentication().getAvailableBiometrics();
      if (!mounted) return;
      if (types.contains(BiometricType.face)) {
        setState(() => _biometricName = 'Face ID');
      } else if (types.contains(BiometricType.fingerprint) ||
          types.contains(BiometricType.strong) ||
          types.contains(BiometricType.weak)) {
        setState(() => _biometricName = 'Touch ID');
      }
      // Else: leave the 'Touch ID' default (macOS is the common case here).
    } catch (_) {
      // Keep the default — this is cosmetic copy only, never functional.
    }
  }

  /// Probes whether this platform can actually host a WebView before we try
  /// to mount one. On Windows, a missing WebView2 Runtime otherwise causes
  /// `flutter_inappwebview` to fail *silently* (no callback ever fires), which
  /// is the root cause of the "opens and loads forever" bug this guards
  /// against. See `webview_runtime_check.dart` for the full explanation.
  Future<void> _runRuntimeCheck() async {
    setState(() => _checkingRuntime = true);
    final isWindows = !kIsWeb && Platform.isWindows;
    final status = await checkWebRuntime(
      isWindows: isWindows,
      getAvailableVersion: WebViewEnvironment.getAvailableVersion,
    );
    if (!mounted) return;

    if (status == WebRuntimeStatus.available && isWindows) {
      final userDataFolder = resolveWindowsUserDataFolder(
        isWindows: true,
        localAppData: Platform.environment['LOCALAPPDATA'],
        temp: Platform.environment['TEMP'],
      );
      try {
        _webViewEnvironment = await WebViewEnvironment.create(
          settings: WebViewEnvironmentSettings(userDataFolder: userDataFolder),
        );
      } catch (e) {
        if (!mounted) return;
        setState(() {
          _checkingRuntime = false;
          _runtimeStatus = status;
          _loading = false;
          _loadError = 'WebView2 の初期化に失敗しました（$e）。'
              'ユーザーが書き込み可能なフォルダに再インストールするか、'
              '管理者権限なしで再試行してください。';
        });
        return;
      }
    }

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
          '読み込みがタイムアウトしました（${_loadTimeout.inSeconds}秒）。\n'
          '接続先: ${FeatureRegistry.entryUrl()}\n'
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
    if (_webViewEnvironment == null && !kIsWeb && Platform.isWindows) {
      _runRuntimeCheck();
      return;
    }
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
    if (didPop) return;
    final controller = _controller;
    if (controller != null && await controller.canGoBack()) {
      await controller.goBack();
      return;
    }
    await SystemNavigator.pop();
  }

  /// Page script (runs at document start on every navigation). It:
  ///   1. captures the typed credentials on login-form submit,
  ///   2. auto-fills (and submits) the login form when creds are saved, and
  ///   3. reports when the login form unmounts (= a successful login).
  /// It targets fe2's stable selectors: `#fe2-login-email`,
  /// `#fe2-login-password`, form `[data-testid="fe2-login-form"]`, submit
  /// `[data-testid="fe2-login-submit"]` (see
  /// apps/fe2-app-shell/src/shell/screens/LoginScreen.tsx). React uses
  /// controlled inputs, so we set values through the native setter and
  /// dispatch `input`/`change` to keep React state in sync.
  static const String _autofillJs = r'''
(function () {
  if (window.__dubAutofillInstalled) return;
  window.__dubAutofillInstalled = true;

  var SEL_EMAIL = '#fe2-login-email';
  var SEL_PW = '#fe2-login-password';
  var SEL_FORM = '[data-testid="fe2-login-form"]';
  var SEL_SUBMIT = '[data-testid="fe2-login-submit"]';

  function setReactValue(el, value) {
    var proto = window.HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  var didFill = false;        // auto-filled the current form appearance already
  var wasFormPresent = false; // login form was on screen on the previous tick

  async function tick() {
    var form = document.querySelector(SEL_FORM);

    if (form) {
      wasFormPresent = true;

      // (1) Capture typed credentials on submit (held in memory, not saved).
      if (!form.__dubCaptureWired) {
        form.__dubCaptureWired = true;
        form.addEventListener('submit', function () {
          var e = document.querySelector(SEL_EMAIL);
          var p = document.querySelector(SEL_PW);
          if (e && p && e.value && p.value) {
            try {
              window.flutter_inappwebview.callHandler('captureCredentials', e.value, p.value);
            } catch (_) {}
          }
        }, true);
      }

      // (2) Auto-fill saved credentials once per form appearance.
      if (!didFill) {
        didFill = true;
        var creds = null;
        try {
          creds = await window.flutter_inappwebview.callHandler('getCredentials');
        } catch (_) {}
        if (creds && creds.email && creds.password) {
          var e = document.querySelector(SEL_EMAIL);
          var p = document.querySelector(SEL_PW);
          if (e && p) {
            setReactValue(e, creds.email);
            setReactValue(p, creds.password);
            var btn = document.querySelector(SEL_SUBMIT);
            if (btn) {
              setTimeout(function () { if (!btn.disabled) btn.click(); }, 200);
            }
          }
        }
      }
    } else if (wasFormPresent) {
      // (3) Login form just unmounted → the login succeeded.
      wasFormPresent = false;
      didFill = false; // allow a future logout → login to re-fill
      try {
        window.flutter_inappwebview.callHandler('loginSucceeded');
      } catch (_) {}
    }
  }

  setInterval(tick, 600);
  if (document.readyState !== 'loading') tick();
  else document.addEventListener('DOMContentLoaded', tick);
})();
''';

  Future<dynamic> _onGetCredentials(List<dynamic> args) async {
    final creds = await ref.read(credentialStoreProvider).read();
    if (creds == null) return null;
    return {'email': creds.email, 'password': creds.password};
  }

  Future<dynamic> _onCaptureCredentials(List<dynamic> args) async {
    if (args.length < 2) return null;
    final email = args[0]?.toString() ?? '';
    final password = args[1]?.toString() ?? '';
    ref.read(autofillControllerProvider.notifier).capture(email, password);
    return true;
  }

  Future<dynamic> _onLoginSucceeded(List<dynamic> args) async {
    // Offer to enable biometric autofill after a fresh, successful manual
    // login.
    if (!mounted) return null;
    final autofill = ref.read(autofillControllerProvider.notifier);
    if (autofill.shouldPromptAfterLogin && _overlay == _Overlay.none) {
      setState(() => _overlay = _Overlay.enablePrompt);
    }
    return null;
  }

  void _closeOverlay() {
    if (mounted) setState(() => _overlay = _Overlay.none);
  }

  Future<void> _acceptEnable() async {
    await ref.read(autofillControllerProvider.notifier).enableFromPending();
    _closeOverlay();
    _snack('次回の起動から $_biometricName で自動ログインします');
  }

  void _declineEnable() {
    ref.read(autofillControllerProvider.notifier).declineThisSession();
    _closeOverlay();
  }

  Future<void> _toggleFromSettings(bool value) async {
    final autofill = ref.read(autofillControllerProvider.notifier);
    if (value) {
      final result = await autofill.enable();
      switch (result) {
        case EnableResult.enabled:
          _snack('次回の起動から $_biometricName で自動ログインします');
        case EnableResult.willPromptOnLogin:
          _snack('ログイン画面でサインインすると、$_biometricName の有効化を確認します');
        case EnableResult.alreadyEnabled:
          break;
      }
    } else {
      await autofill.disable();
      _snack('自動ログインを無効にしました（保存した認証情報を削除しました）');
    }
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    final autofill = ref.watch(autofillControllerProvider);

    if (_checkingRuntime) {
      return const _CenteredMessage(child: CircularProgressIndicator());
    }

    if (_runtimeStatus == WebRuntimeStatus.missingOnWindows) {
      return _WebView2MissingScreen(onRetry: _runRuntimeCheck);
    }

    // Intercept the Android back button/gesture. canPop:false so every back
    // event reaches [_onPopInvoked], which decides WebView-back vs exit.
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: _onPopInvoked,
      child: Scaffold(
        // SafeArea keeps the WebView clear of the status bar, notch and
        // gesture/navigation insets so the web UI never hides under system bars.
        body: SafeArea(
          child: Stack(
            children: [
              InAppWebView(
                key: _webViewKey,
                webViewEnvironment: _webViewEnvironment,
                initialUrlRequest: URLRequest(
                  url: WebUri(FeatureRegistry.entryUrl()),
                ),
                initialUserScripts: UnmodifiableListView<UserScript>([
                  UserScript(
                    source: _autofillJs,
                    injectionTime: UserScriptInjectionTime.AT_DOCUMENT_START,
                  ),
                ]),
                initialSettings: InAppWebViewSettings(
                  transparentBackground: false,
                  javaScriptEnabled: true,
                  javaScriptCanOpenWindowsAutomatically: true,
                  supportZoom: false,
                  applicationNameForUserAgent: 'Dub-Desktop',
                ),
                onWebViewCreated: (controller) {
                  _controller = controller;
                  controller.addJavaScriptHandler(
                    handlerName: 'getCredentials',
                    callback: _onGetCredentials,
                  );
                  controller.addJavaScriptHandler(
                    handlerName: 'captureCredentials',
                    callback: _onCaptureCredentials,
                  );
                  controller.addJavaScriptHandler(
                    handlerName: 'loginSucceeded',
                    callback: _onLoginSucceeded,
                  );
                },
                onLoadStop: (controller, url) {
                  _onLoadFinished();
                },
                onReceivedError: (controller, request, error) {
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

              // Subtle native settings affordance (bottom-left; away from the
              // web app's own top-bar controls).
              if (!_loading && _loadError == null && _overlay == _Overlay.none)
                Positioned(
                  left: 12,
                  bottom: 12,
                  child: _SettingsButton(
                    onPressed: () =>
                        setState(() => _overlay = _Overlay.settings),
                  ),
                ),

              if (_overlay == _Overlay.enablePrompt)
                _EnablePromptCard(
                  biometricName: _biometricName,
                  onEnable: _acceptEnable,
                  onDecline: _declineEnable,
                ),

              if (_overlay == _Overlay.settings)
                _SettingsCard(
                  biometricName: _biometricName,
                  enabled: autofill.enabled,
                  onToggle: _toggleFromSettings,
                  onClose: _closeOverlay,
                ),
            ],
          ),
        ),
      ),
    );
  }
}

enum _Overlay { none, enablePrompt, settings }

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
/// Runtime installed.
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

/// Small, low-key fingerprint button pinned to the corner that opens the native
/// autofill settings panel.
class _SettingsButton extends StatelessWidget {
  const _SettingsButton({required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return Opacity(
      opacity: 0.55,
      child: Material(
        color: Colors.black.withValues(alpha: 0.55),
        shape: const CircleBorder(),
        clipBehavior: Clip.antiAlias,
        child: Tooltip(
          message: '自動ログイン設定',
          child: IconButton(
            iconSize: 18,
            color: Colors.white,
            icon: const Icon(Icons.fingerprint),
            onPressed: onPressed,
          ),
        ),
      ),
    );
  }
}

/// Modal shown right after the first successful manual login, asking whether to
/// enable biometric autofill. Rendered as an in-Stack overlay (same compositing
/// path as the loading overlay) rather than a route, to sit reliably above the
/// native WebView platform view.
class _EnablePromptCard extends StatelessWidget {
  const _EnablePromptCard({
    required this.biometricName,
    required this.onEnable,
    required this.onDecline,
  });

  final String biometricName;
  final Future<void> Function() onEnable;
  final VoidCallback onDecline;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return _Scrim(
      onDismiss: onDecline,
      child: _Card(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.fingerprint,
                    size: 28, color: theme.colorScheme.primary),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    '$biometricName でログインを自動化しますか？',
                    style: theme.textTheme.titleMedium,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Text(
              '次回からは $biometricName で本人確認するだけでログインできます。'
              '入力した認証情報はこの端末の Keychain に安全に保存され、'
              'ファイルやログには残りません。',
              style: theme.textTheme.bodyMedium,
            ),
            const SizedBox(height: 20),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: onDecline,
                  child: const Text('今はしない'),
                ),
                const SizedBox(width: 8),
                FilledButton.icon(
                  onPressed: onEnable,
                  icon: const Icon(Icons.fingerprint),
                  label: const Text('有効にする'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Settings panel to toggle biometric autofill on/off after the fact.
class _SettingsCard extends StatelessWidget {
  const _SettingsCard({
    required this.biometricName,
    required this.enabled,
    required this.onToggle,
    required this.onClose,
  });

  final String biometricName;
  final bool enabled;
  final Future<void> Function(bool) onToggle;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return _Scrim(
      onDismiss: onClose,
      child: _Card(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text('自動ログイン設定', style: theme.textTheme.titleMedium),
                const Spacer(),
                IconButton(
                  icon: const Icon(Icons.close),
                  onPressed: onClose,
                ),
              ],
            ),
            const SizedBox(height: 4),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              value: enabled,
              onChanged: (v) => onToggle(v),
              title: Text('$biometricName でログインを自動化'),
              subtitle: Text(
                enabled
                    ? '有効。起動時に $biometricName で本人確認し、ログイン情報を自動入力します。'
                    : '無効。オンにすると、次のログイン以降 $biometricName で自動入力します。',
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Dimmed, tap-to-dismiss backdrop for the overlay cards.
class _Scrim extends StatelessWidget {
  const _Scrim({required this.child, required this.onDismiss});

  final Widget child;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        Positioned.fill(
          child: GestureDetector(
            onTap: onDismiss,
            child: const ColoredBox(color: Color(0x99000000)),
          ),
        ),
        Center(child: child),
      ],
    );
  }
}

/// Consistent white card container for the overlay content.
class _Card extends StatelessWidget {
  const _Card({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 420),
      child: Material(
        color: Theme.of(context).colorScheme.surface,
        borderRadius: BorderRadius.circular(16),
        elevation: 8,
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: child,
        ),
      ),
    );
  }
}
