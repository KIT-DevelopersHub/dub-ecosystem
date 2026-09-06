import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Controls the WebView's persisted browser session (cookies + cached web data).
///
/// This is the piece that makes the biometric gate actually mean something. The
/// fe2 SPA keeps the user signed in with an HTTP **session cookie** (the API
/// client sends `credentials: "include"` and the server rotates `Set-Cookie`).
/// That cookie survives app restarts in the WebView's cookie store, so without
/// this seam a relaunch would drop straight back into the *previous* person's
/// logged-in account — no password, and (when the gate isn't armed) no biometric
/// either. Biometric alone would only prove "the device owner is here", never
/// "this is account X".
///
/// So the shell **clears the session at every launch and on explicit lock**, and
/// only re-establishes it *after* a successful authentication by auto-filling the
/// bound account's saved credentials into the login form. The signed-in session
/// is therefore always tied to a fresh biometric confirmation of the bound
/// account, never to a stale cookie.
abstract class WebSession {
  /// Wipe all cookies + cached web data so the SPA starts signed-out and the
  /// person must re-authenticate (biometric → autofill, or manual login).
  Future<void> clear();
}

/// Production implementation backed by the platform WebView (WKWebView on macOS,
/// WebView2 on Windows) via flutter_inappwebview's managers. The cookie store is
/// process-global, so this works before any [InAppWebView] widget is mounted.
class PlatformWebSession implements WebSession {
  const PlatformWebSession();

  @override
  Future<void> clear() async {
    // Cookies carry the fe2 auth/refresh session → this is the load-bearing
    // clear. Best-effort cache wipe on top so nothing survives in disk cache.
    await CookieManager.instance().deleteAllCookies();
    try {
      await InAppWebViewController.clearAllCache();
    } catch (_) {
      // clearAllCache is best-effort / not on every platform; ignore failures.
    }
  }
}

final webSessionProvider =
    Provider<WebSession>((ref) => const PlatformWebSession());
