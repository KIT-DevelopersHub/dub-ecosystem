import '../config.dart';

/// What the shell does with a navigation the WebView is about to perform.
enum LinkAction {
  /// Let the WebView load it as-is (normal in-app navigation).
  allow,

  /// A Dub-owned page asked for a new window (`target=_blank`, `window.open`):
  /// show it in the in-app viewer so the session cookie still applies.
  openInAppViewer,

  /// Hand it to the OS (Safari / Chrome / Mail / Phone ...).
  openExternal,
}

/// Hosts whose pages belong to Dub and are shown inside the app.
Set<String> defaultAppHosts() => {
      for (final url in [
        AppConfig.webBaseUrl,
        AppConfig.apiBaseUrl,
        AppConfig.mo3BaseUrl,
      ])
        if (Uri.tryParse(url)?.host case final host? when host.isNotEmpty)
          host.toLowerCase(),
    };

/// Decides where a navigation goes.
///
/// - `isMainFrame`: the top-level document is navigating (not an iframe).
/// - `newWindow`: the page asked for a new window.
LinkAction classifyNavigation(
  Uri uri, {
  required bool isMainFrame,
  required bool newWindow,
  required Set<String> appHosts,
}) {
  final scheme = uri.scheme.toLowerCase();

  // In-page schemes never leave the WebView.
  if (const {'about', 'blob', 'data', 'javascript'}.contains(scheme)) {
    return LinkAction.allow;
  }

  if (scheme == 'http' || scheme == 'https') {
    final isAppHost = appHosts.contains(uri.host.toLowerCase());
    if (newWindow) {
      return isAppHost ? LinkAction.openInAppViewer : LinkAction.openExternal;
    }
    // Iframes (mail bodies, embeds) keep their own navigation.
    if (!isMainFrame) return LinkAction.allow;
    return isAppHost ? LinkAction.allow : LinkAction.openExternal;
  }

  // mailto:, tel:, sms:, maps:, app deep links ...
  return LinkAction.openExternal;
}
