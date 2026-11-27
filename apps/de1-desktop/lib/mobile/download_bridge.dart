/// Page script that hands browser-style downloads to the native shell.
///
/// The web app saves files the browser way: `URL.createObjectURL(blob)` +
/// `<a download>` + `a.click()`. A phone WebView ignores that, so this script
/// remembers each created Blob and, when such a link is clicked, sends the
/// bytes to the native `saveFile` handler instead.
class DownloadBridge {
  const DownloadBridge._();

  static const String handlerName = 'saveFile';

  static String jsSource() => '''
(function () {
  if (window.__dubDownloadInstalled) return;
  window.__dubDownloadInstalled = true;

  // The app revokes the URL right after click(); keep the Blob a little longer.
  var blobs = new Map();
  var createObjectURL = URL.createObjectURL.bind(URL);
  var revokeObjectURL = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = function (obj) {
    var url = createObjectURL(obj);
    if (obj instanceof Blob) blobs.set(url, obj);
    return url;
  };
  URL.revokeObjectURL = function (url) {
    setTimeout(function () { blobs.delete(url); }, 60000);
    return revokeObjectURL(url);
  };

  function base64Of(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var s = String(reader.result);
        resolve(s.slice(s.indexOf(',') + 1));
      };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(blob);
    });
  }

  async function save(href, name) {
    var blob = blobs.get(href);
    if (!blob) blob = await (await fetch(href)).blob();
    var data = await base64Of(blob);
    await window.flutter_inappwebview.callHandler(
      '$handlerName', name || 'download', blob.type || 'application/octet-stream', data);
  }

  function isLocalFile(a) {
    var href = a.href || '';
    return href.indexOf('blob:') === 0 || href.indexOf('data:') === 0;
  }

  function handle(a) {
    save(a.href, a.getAttribute('download') || '').catch(function (e) {
      console.warn('[dub] download failed', e);
    });
  }

  // a.click() on a detached or attached anchor.
  var originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (isLocalFile(this)) { handle(this); return; }
    return originalClick.apply(this, arguments);
  };

  // Real taps on such links.
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a || !isLocalFile(a)) return;
    ev.preventDefault();
    ev.stopPropagation();
    handle(a);
  }, true);
})();
''';
}
