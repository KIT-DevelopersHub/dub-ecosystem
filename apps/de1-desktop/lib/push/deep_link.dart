/// Resolves a remote-push `data.deepLink` value into an in-SPA path the WebView
/// can navigate to. Mirrors the mobile clients' rules
/// (apps/mo2-android/src/deep-link.ts, apps/mo1-ios/src/deeplink.ts):
///
///   * Accept `https://developershub.jp/...` and `https://m.developershub.jp/...`
///   * Accept `dub://<seg>/...` (the scheme host is treated as the first path
///     segment)
///   * Everything else (foreign origin, unparseable, missing) → home (`/`)
///
/// Path mapping (segment `→` web SPA route), where `id` is an entity id:
/// ```text
///   home                 → /
///   inbox                → /notifications
///   events/id            → /events/id
///   events/id/gantt      → /events/id/gantt
///   gantt/eventId        → /events/eventId/gantt
///   actions/id           → /events/actions/id   (action lives under events)
///   tasks/id             → /tasks/id
///   chat                 → /chat
///   chat/channels/id     → /chat/id
///   chat/id              → /chat/id
///   profile | me         → /settings
///   (anything else)      → /
/// ```
library;

const _appLinkHosts = {'developershub.jp', 'm.developershub.jp'};
const _scheme = 'dub';

/// Web SPA fallback route (home).
const kHomePath = '/';

/// Resolve [deepLink] to an in-SPA path, or [kHomePath] when it is missing,
/// foreign, or unrecognised.
String resolveDeepLink(String? deepLink) {
  if (deepLink == null || deepLink.trim().isEmpty) return kHomePath;
  Uri uri;
  try {
    uri = Uri.parse(deepLink.trim());
  } catch (_) {
    return kHomePath;
  }

  List<String> segments;
  if (uri.scheme == 'https') {
    if (!_appLinkHosts.contains(uri.host)) return kHomePath;
    segments = uri.pathSegments.where((s) => s.isNotEmpty).toList();
  } else if (uri.scheme == _scheme) {
    // dub://<seg>/<rest> — the authority is the first logical segment.
    segments = [
      if (uri.host.isNotEmpty) uri.host,
      ...uri.pathSegments.where((s) => s.isNotEmpty),
    ];
  } else {
    return kHomePath;
  }

  return _mapSegments(segments);
}

String _mapSegments(List<String> s) {
  if (s.isEmpty) return kHomePath;
  final head = s[0];
  switch (head) {
    case 'home':
      return kHomePath;
    case 'inbox':
      return '/notifications';
    case 'events':
      if (s.length >= 3 && s[2] == 'gantt') return '/events/${s[1]}/gantt';
      if (s.length >= 2) return '/events/${s[1]}';
      return kHomePath;
    case 'gantt':
      if (s.length >= 2) return '/events/${s[1]}/gantt';
      return kHomePath;
    case 'actions':
      if (s.length >= 2) return '/events/actions/${s[1]}';
      return kHomePath;
    case 'tasks':
      if (s.length >= 2) return '/tasks/${s[1]}';
      return kHomePath;
    case 'chat':
      if (s.length >= 3 && s[1] == 'channels') return '/chat/${s[2]}';
      if (s.length >= 2) return '/chat/${s[1]}';
      return '/chat';
    case 'profile':
    case 'me':
      return '/settings';
    default:
      return kHomePath;
  }
}
