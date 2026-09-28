/// Preflight check for the platform's embedded browser engine.
///
/// Root cause of the "opens on Windows and just spins forever" bug: the whole
/// desktop app is a WebView pointed at the production Web SPA
/// ([FeatureRegistry.entryUrl]), and on Windows `flutter_inappwebview` is
/// backed by Microsoft Edge WebView2. WebView2 itself is NOT bundled with the
/// app — it relies on the OS-wide "Evergreen" WebView2 Runtime, which ships
/// preinstalled on most Windows 11 machines but is frequently missing on
/// Windows 10 / locked-down or freshly-imaged machines. When it is missing,
/// WebView2 host-process creation fails *silently* from Flutter's point of
/// view: `onWebViewCreated`, `onLoadStop` and `onReceivedError` never fire, so
/// the `_loading` spinner in [WebShell] spun forever with zero feedback.
///
/// This check runs [getAvailableVersion] (normally
/// `WebViewEnvironment.getAvailableVersion`, Microsoft's own probe for an
/// installed WebView2 Runtime / non-stable Edge) before we ever try to mount
/// the WebView, so we can show an actionable "install WebView2" screen
/// instead of hanging. Kept as a free function (not inlined into the widget)
/// so the decision table is unit-testable without touching platform channels.
library;

/// Outcome of [checkWebRuntime].
enum WebRuntimeStatus {
  /// Either not Windows (macOS's WKWebView needs no separate runtime), or
  /// Windows with a WebView2 Runtime detected. Safe to mount the WebView.
  available,

  /// Windows, and no WebView2 Runtime / non-stable Edge could be found (or
  /// the probe itself failed). Mounting the WebView would hang silently;
  /// show the install-guidance screen instead.
  missingOnWindows,
}

/// Pure, testable core of the preflight check.
///
/// [isWindows] is passed in (rather than read from `dart:io` here) so tests
/// can exercise both branches without needing a real Windows host.
/// [getAvailableVersion] is normally `WebViewEnvironment.getAvailableVersion`,
/// which resolves to the installed browser version string, or `null` if none
/// is found.
Future<WebRuntimeStatus> checkWebRuntime({
  required bool isWindows,
  required Future<String?> Function() getAvailableVersion,
}) async {
  if (!isWindows) return WebRuntimeStatus.available;
  try {
    final version = await getAvailableVersion();
    return version == null
        ? WebRuntimeStatus.missingOnWindows
        : WebRuntimeStatus.available;
  } catch (_) {
    // The probe itself threw (e.g. the native plugin call failed). Treat this
    // the same as "missing" — showing the actionable screen is strictly
    // better than falling through to a silent hang.
    return WebRuntimeStatus.missingOnWindows;
  }
}

/// Computes a writable folder for the WebView2 *user data* store.
///
/// Root cause of the "WebView2 Runtime IS installed, yet the app still shows
/// a 20s timeout / never loads" follow-up bug: `flutter_inappwebview`'s
/// `InAppWebView` calls `CreateCoreWebView2EnvironmentWithOptions(nullptr,
/// nullptr, ...)` by default. Per Microsoft's own docs, when `userDataFolder`
/// is null, WebView2 tries to create `<exe folder>\<exe name>.WebView2`
/// *right next to the compiled app* — and "WebView2 creation fails if the
/// compiled code is running in a directory in which the process does not
/// have permission to create a new directory."
///
/// This app's Windows installer (`windows/packaging/dub.iss`) installs into
/// `{autopf}\Dub`, i.e. `%ProgramFiles%\Dub` once the user accepts the UAC
/// elevation prompt Inno Setup shows by default. A normal (non-elevated)
/// desktop process has no write access there, so environment creation fails
/// with an access-denied HRESULT *before any WebView or navigation exists* —
/// none of `onWebViewCreated` / `onLoadStop` / `onReceivedError` ever fire,
/// and the shell's failsafe timer eventually fires a generic "timed out"
/// message even though no network request was ever attempted.
///
/// Fix: always point WebView2 at an explicit folder under the current user's
/// profile (`%LOCALAPPDATA%`, guaranteed writable regardless of where the app
/// itself is installed), falling back to `%TEMP%` if that is somehow unset.
/// Returns `null` on non-Windows platforms (irrelevant there) or if neither
/// environment variable is available, in which case the caller falls back to
/// the plugin's own (unreliable) default.
String? resolveWindowsUserDataFolder({
  required bool isWindows,
  required String? localAppData,
  required String? temp,
}) {
  if (!isWindows) return null;
  final base = (localAppData != null && localAppData.isNotEmpty)
      ? localAppData
      : temp;
  if (base == null || base.isEmpty) return null;
  return '$base\\Dub\\WebView2';
}
