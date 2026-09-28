/// Static app configuration for the Dub desktop client.
///
/// Dub desktop is a **thin native shell around the real web app**: the window
/// renders the production Web SPA (`fe2-app-shell`) verbatim, so the desktop UI
/// is a pixel-for-pixel copy of the web UI and auto-follows every web deploy.
///
/// [webBaseUrl] is the single thing the shell needs to know — the origin of the
/// Web SPA to load. It defaults to the production fe2 worker and can be
/// overridden at build/run time with
/// `--dart-define=WEB_BASE_URL=https://dub-fe2-app-shell.developershub-site.workers.dev`
/// (e.g. to point at the demo environment or a local `vite dev` server).
class AppConfig {
  const AppConfig._();

  /// Origin of the Web SPA the desktop window renders.
  ///
  /// Default = the production fe2-app-shell worker. NOT `api.developershub.jp`
  /// (that custom domain is not DNS-configured); this is the real, reachable
  /// workers.dev origin the browser build is served from.
  static const String webBaseUrl = String.fromEnvironment(
    'WEB_BASE_URL',
    defaultValue: 'https://dub-fe2-app-shell.developershub-site.workers.dev',
  );

  /// Origin of the API gateway the SPA talks to (cross-origin from [webBaseUrl];
  /// cookie session is shared via the WebView cookie store). Used as the DEFAULT
  /// base for the foreground notification watcher's own inbox polls — the
  /// injected watcher upgrades this automatically if it observes the SPA calling
  /// a different `/api/v1/` origin (e.g. demo/staging), so this only needs to be
  /// right for the common production case.
  ///
  /// Mirrors fe2's `GATEWAY_FALLBACK`
  /// (apps/fe2-app-shell/src/lib/resolve-base-url.tsx). Overridable with
  /// `--dart-define=API_BASE_URL=...`.
  static const String apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'https://dub-api-gateway.developershub-site.workers.dev',
  );

  /// Origin of the mo3-mobile-bff (the device-registration + push-dispatch BFF).
  ///
  /// Default = the planned custom route `m-api.developershub.jp` (see
  /// apps/mo3-mobile-bff/wrangler.toml, currently `workers_dev = false` and the
  /// route commented — so this is NOT live yet; Phase 1 device registration is
  /// blocked on that deploy + the mobile auth seam, 設計 未決事項 B).
  /// Overridable with `--dart-define=MO3_BASE_URL=...`.
  static const String mo3BaseUrl = String.fromEnvironment(
    'MO3_BASE_URL',
    defaultValue: 'https://m-api.developershub.jp',
  );
}
