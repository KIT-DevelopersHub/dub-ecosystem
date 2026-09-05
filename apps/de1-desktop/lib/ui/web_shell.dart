import 'dart:collection';

import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../feature_registry.dart';
import '../state/credential_store.dart';

/// Full-window WebView hosting the production Web SPA (fe2-app-shell).
///
/// The window is a literal copy of the web app — same login, same 9-dot
/// launcher, same screens. The *only* native behaviour layered on top is
/// credential autofill: this shell mounts strictly **after** the biometric
/// launch gate has been passed, so when it injects the saved credentials into
/// the web login form the person has already been verified by the OS.
///
/// Two JS bridges connect the injected page script to the OS secure store:
///   - `getCredentials` → returns the saved `{email, password}` so the script
///     can fill (and submit) the web login form.
///   - `saveCredentials` → called when the user completes a manual login, so
///     the next launch can be biometric-gated + auto-filled.
///
/// The password only ever lives in the WebView JS context (exactly as a browser
/// password manager would fill it) and in the OS Keychain/Credential Manager.
/// It is never written to a file or a log.
class WebShell extends ConsumerStatefulWidget {
  const WebShell({super.key});

  @override
  ConsumerState<WebShell> createState() => _WebShellState();
}

class _WebShellState extends ConsumerState<WebShell> {
  bool _loading = true;

  /// Page script (runs at document start on every navigation). It:
  ///   1. wires the login form's submit to capture the typed credentials, and
  ///   2. auto-fills (and clicks submit on) the login form when the shell has
  ///      saved credentials.
  /// It targets fe2's stable selectors: `#fe2-login-email`,
  /// `#fe2-login-password`, form `[data-testid="fe2-login-form"]`, submit
  /// `[data-testid="fe2-login-submit"]`. React uses controlled inputs, so we
  /// set values through the native setter and dispatch an `input` event to keep
  /// React state in sync.
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

  var didFill = false;

  async function tick() {
    var form = document.querySelector(SEL_FORM);
    if (!form) { didFill = false; return; }

    // (1) Capture typed credentials on submit so we can save them.
    if (!form.__dubCaptureWired) {
      form.__dubCaptureWired = true;
      form.addEventListener('submit', function () {
        var e = document.querySelector(SEL_EMAIL);
        var p = document.querySelector(SEL_PW);
        if (e && p && e.value && p.value) {
          try {
            window.flutter_inappwebview.callHandler('saveCredentials', e.value, p.value);
          } catch (_) {}
        }
      }, true);
    }

    // (2) Auto-fill saved credentials (once per login-form appearance).
    if (didFill) return;
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
        didFill = true;
        var btn = document.querySelector(SEL_SUBMIT);
        if (btn) {
          setTimeout(function () { if (!btn.disabled) btn.click(); }, 200);
        }
      }
    } else {
      didFill = true; // nothing saved → don't keep re-querying this form
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

  Future<dynamic> _onSaveCredentials(List<dynamic> args) async {
    if (args.length < 2) return null;
    final email = args[0]?.toString() ?? '';
    final password = args[1]?.toString() ?? '';
    if (email.isEmpty || password.isEmpty) return null;
    await ref
        .read(credentialStoreProvider)
        .save(Credentials(email: email, password: password));
    return true;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Stack(
        children: [
          InAppWebView(
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
              controller.addJavaScriptHandler(
                handlerName: 'getCredentials',
                callback: _onGetCredentials,
              );
              controller.addJavaScriptHandler(
                handlerName: 'saveCredentials',
                callback: _onSaveCredentials,
              );
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
    );
  }
}
