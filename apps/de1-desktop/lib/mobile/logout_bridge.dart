/// Page script that tells the native shell the web app is about to log out,
/// while the session is still valid (so the push device can be unregistered
/// with it).
///
/// Wraps `fetch` for `POST …/api/v1/auth/logout` only, waits for the native
/// `beforeLogout` handler (at most 3 s), then sends the real request.
class LogoutBridge {
  const LogoutBridge._();

  static const String handlerName = 'beforeLogout';

  static String jsSource() => '''
(function () {
  if (window.__dubLogoutInstalled) return;
  window.__dubLogoutInstalled = true;

  var originalFetch = window.fetch;
  if (typeof originalFetch !== 'function') return;

  function isLogout(input, init) {
    try {
      var url = typeof input === 'string' ? input : (input && input.url) || String(input);
      var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      return method === 'POST' &&
        /\\/api\\/v1\\/auth\\/logout\$/.test(new URL(url, location.href).pathname);
    } catch (_) {
      return false;
    }
  }

  window.fetch = function (input, init) {
    var self = this;
    var args = arguments;
    if (!isLogout(input, init)) return originalFetch.apply(self, args);
    var notify;
    try {
      notify = Promise.resolve(window.flutter_inappwebview.callHandler('$handlerName'));
    } catch (_) {
      notify = Promise.resolve();
    }
    var timeout = new Promise(function (resolve) { setTimeout(resolve, 3000); });
    return Promise.race([notify.catch(function () {}), timeout]).then(function () {
      return originalFetch.apply(self, args);
    });
  };
})();
''';
}
