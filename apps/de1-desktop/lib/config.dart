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
}
