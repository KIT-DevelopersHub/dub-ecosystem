/// Page script that turns "open in a new window" into a call to the native
/// shell, because a phone WebView has no second window to open.
///
/// Catches `<a target="_blank">` clicks (after the SPA's own handlers ran, so
/// router links are untouched) and `window.open(url)`. Links with `download`
/// are left alone for the download bridge.
class NewWindowBridge {
  const NewWindowBridge._();

  static const String handlerName = 'openWindow';

  static String jsSource() => '''
(function () {
  if (window.__dubNewWindowInstalled) return;
  window.__dubNewWindowInstalled = true;

  function send(url) {
    try {
      window.flutter_inappwebview.callHandler('$handlerName', String(url));
      return true;
    } catch (_) {
      return false;
    }
  }

  window.addEventListener('click', function (ev) {
    if (ev.defaultPrevented || ev.button !== 0) return;
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a || a.hasAttribute('download')) return;
    if ((a.getAttribute('target') || '').toLowerCase() !== '_blank') return;
    if (send(a.href)) ev.preventDefault();
  }, false);

  var originalOpen = window.open;
  window.open = function (url, target) {
    var t = (target || '_blank').toLowerCase();
    if (url && (t === '_blank' || t === '')) {
      try {
        if (send(new URL(url, location.href).href)) return null;
      } catch (_) {}
    }
    return originalOpen.apply(window, arguments);
  };
})();
''';
}
