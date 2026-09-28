import '../config.dart';

/// Phase 0 — foreground OS notifications with ZERO server changes and ZERO cost.
///
/// The web SPA has no realtime notification stream today: the inbox is a 60s
/// unread-count poll and the only SSE path carries just the integer badge count
/// (see apps/fe5-notification-inbox/src/lib/{poller,unread-live}.ts). So instead
/// of duplicating a WS/auth client in Dart, this user-script runs INSIDE the
/// authenticated page and re-uses the SPA's own session:
///
///   1. It watches the SPA's own `/api/v1/...` traffic to learn the gateway
///      origin and any auth header the SPA attaches (so the poll is
///      auto-configured for prod/demo/staging alike).
///   2. It polls the existing `GET /api/v1/notifications/inbox?unreadOnly=true`
///      with `credentials:'include'` — the same cookie session the SPA uses.
///   3. On the FIRST poll it only records the current unread ids as a baseline
///      (no burst of notifications for pre-existing unread items).
///   4. Any genuinely NEW unread item is posted to the `dubPushEvent` Flutter
///      handler, which shows an OS notification. Seen ids persist in
///      localStorage so a relaunch does not re-fire.
///   5. The deep-link path is derived from `(resourceType, resourceId)` exactly
///      as fe5 does (apps/fe5-notification-inbox/.../NotificationListItem.ts
///      `itemLinkUrl`): task→`/tasks/id`, event→`/events/id`, file→`/files/id`,
///      else the inbox.
///
/// It also installs `window.__dubNavigate(path)` for the native tap handler to
/// drive in-SPA (client-side) navigation without a full reload.
///
/// Suppression of double display vs. a foreground remote push is handled on the
/// native side (FCM foreground messages are not shown — the watcher owns
/// foreground display; see `fcm_push.dart`).
class ForegroundBridge {
  ForegroundBridge._();

  /// Flutter <- JS handler name carrying one new notification as a JSON string.
  static const handlerName = 'dubPushEvent';

  /// Poll cadence. Kept modest (free-tier friendly); deliberately does NOT pause
  /// while the window is hidden — an unfocused/minimized window is exactly when
  /// a foreground OS notification is most useful.
  static const _pollMs = 25000;

  /// The injected user-script source. `AppConfig.apiBaseUrl` is baked in as the
  /// default gateway origin; the script upgrades it if it sees the SPA using a
  /// different `/api/v1/` origin.
  static String jsSource() => '''
(function () {
  if (window.__dubPushInstalled) return;
  window.__dubPushInstalled = true;

  var API_BASE = ${_jsString(AppConfig.apiBaseUrl)};
  var INBOX_PATH = '/api/v1/notifications/inbox';
  var POLL_MS = $_pollMs;
  var SEEN_KEY = '__dub_push_seen_v1';
  var MAX_SEEN = 500;

  var lastAuth = null;       // Authorization header last seen on an /api/v1/ call
  var baselined = false;     // first poll only records ids, does not notify

  // ---- persisted "already shown" id set ------------------------------------
  function loadSeen() {
    try {
      var raw = window.localStorage.getItem(SEEN_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }
  function saveSeen(arr) {
    try {
      if (arr.length > MAX_SEEN) arr = arr.slice(arr.length - MAX_SEEN);
      window.localStorage.setItem(SEEN_KEY, JSON.stringify(arr));
    } catch (_) {}
  }
  var seen = loadSeen();
  var seenSet = {};
  for (var i = 0; i < seen.length; i++) seenSet[seen[i]] = true;
  function markSeen(id) {
    if (seenSet[id]) return false;
    seenSet[id] = true;
    seen.push(id);
    saveSeen(seen);
    return true;
  }

  // ---- learn gateway origin + auth from the SPA's own requests --------------
  function noteRequest(url, headers) {
    try {
      if (typeof url !== 'string') return;
      var idx = url.indexOf('/api/v1/');
      if (idx < 0) return;
      var origin = idx === 0 ? '' : url.slice(0, idx);
      if (origin && /^https?:\\/\\//.test(origin)) API_BASE = origin;
      if (headers) {
        var a = headers['authorization'] || headers['Authorization'];
        if (a) lastAuth = a;
      }
    } catch (_) {}
  }

  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch) {
    window.fetch = function (input, init) {
      try {
        var url = (typeof input === 'string') ? input : (input && input.url);
        var hdrs = {};
        if (init && init.headers) {
          if (init.headers.forEach) init.headers.forEach(function (v, k) { hdrs[k] = v; });
          else hdrs = init.headers;
        }
        noteRequest(url, hdrs);
      } catch (_) {}
      return origFetch(input, init);
    };
  }
  var OrigXHR = window.XMLHttpRequest;
  if (OrigXHR) {
    var origOpen = OrigXHR.prototype.open;
    var origSet = OrigXHR.prototype.setRequestHeader;
    OrigXHR.prototype.open = function (method, url) {
      this.__dubUrl = url; this.__dubHeaders = {};
      return origOpen.apply(this, arguments);
    };
    OrigXHR.prototype.setRequestHeader = function (k, v) {
      try { if (this.__dubHeaders) this.__dubHeaders[k] = v; } catch (_) {}
      return origSet.apply(this, arguments);
    };
    var origSend = OrigXHR.prototype.send;
    OrigXHR.prototype.send = function () {
      try { noteRequest(this.__dubUrl, this.__dubHeaders); } catch (_) {}
      return origSend.apply(this, arguments);
    };
  }

  // ---- deep-link: mirror fe5 itemLinkUrl -----------------------------------
  function itemLinkUrl(item) {
    if (!item || !item.resourceType || !item.resourceId) return null;
    switch (item.resourceType) {
      case 'task':  return '/tasks/'  + item.resourceId;
      case 'event': return '/events/' + item.resourceId;
      case 'file':  return '/files/'  + item.resourceId;
      default:      return null;
    }
  }

  function emit(item) {
    var payload = {
      id: String(item.id),
      title: item.title || 'Dub',
      body: item.body || '',
      url: itemLinkUrl(item),
      type: item.type || null
    };
    try {
      window.flutter_inappwebview.callHandler('$handlerName', JSON.stringify(payload));
    } catch (_) {}
  }

  // ---- the poll ------------------------------------------------------------
  var inFlight = false;
  async function poll() {
    if (inFlight) return;
    inFlight = true;
    try {
      var headers = { accept: 'application/json' };
      if (lastAuth) headers['authorization'] = lastAuth;
      var res = await fetch(API_BASE + INBOX_PATH + '?unreadOnly=true&limit=20', {
        method: 'GET', credentials: 'include', headers: headers
      });
      if (!res || !res.ok) return;
      var data = await res.json();
      var items = (data && (data.items || data.data || data.results)) || [];
      if (!Array.isArray(items)) return;
      if (!baselined) {
        // Record every current unread id without notifying.
        for (var i = 0; i < items.length; i++) markSeen(String(items[i].id));
        baselined = true;
        return;
      }
      // Oldest-first so multiple new items notify in chronological order.
      for (var j = items.length - 1; j >= 0; j--) {
        var it = items[j];
        if (it && it.readAt == null && markSeen(String(it.id))) emit(it);
      }
    } catch (_) {
      // Silent: transient network/auth errors just retry next tick.
    } finally {
      inFlight = false;
    }
  }

  // ---- in-SPA navigation for the native tap handler ------------------------
  window.__dubNavigate = function (path) {
    try {
      if (!path || path.charAt(0) !== '/') path = '/notifications';
      window.history.pushState({}, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
    } catch (_) {
      try { window.location.assign(path); } catch (__) {}
    }
  };

  setInterval(poll, POLL_MS);
  // Kick one baseline poll shortly after load (give the SPA a moment to auth).
  setTimeout(poll, 3000);
})();
''';

  static String _jsString(String s) =>
      '"${s.replaceAll(r'\', r'\\').replaceAll('"', r'\"')}"';
}
