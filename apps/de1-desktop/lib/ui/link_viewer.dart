import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:url_launcher/url_launcher.dart';

import '../mobile/link_policy.dart';

/// Full-screen viewer for a Dub page that asked for a new window
/// (chat attachments, `target=_blank` links to Dub itself).
///
/// It shares the cookie store with the main WebView, so session-protected
/// files open without logging in again. Links to other sites still go to the
/// OS browser.
class LinkViewerPage extends StatefulWidget {
  const LinkViewerPage({super.key, required this.url, required this.appHosts});

  final Uri url;
  final Set<String> appHosts;

  static Future<void> open(BuildContext context, Uri url, Set<String> appHosts) {
    return Navigator.of(context).push(
      MaterialPageRoute<void>(
        fullscreenDialog: true,
        builder: (_) => LinkViewerPage(url: url, appHosts: appHosts),
      ),
    );
  }

  @override
  State<LinkViewerPage> createState() => _LinkViewerPageState();
}

class _LinkViewerPageState extends State<LinkViewerPage> {
  InAppWebViewController? _controller;
  late String _title = widget.url.host;
  double _progress = 0;

  Future<void> _onPopInvoked(bool didPop, Object? result) async {
    if (didPop) return;
    final controller = _controller;
    if (controller != null && await controller.canGoBack()) {
      await controller.goBack();
      return;
    }
    if (mounted) Navigator.of(context).pop();
  }

  Future<void> _openInBrowser() async {
    final current = await _controller?.getUrl();
    await launchUrl(current ?? widget.url, mode: LaunchMode.externalApplication);
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: _onPopInvoked,
      child: Scaffold(
        appBar: AppBar(
          leading: IconButton(
            icon: const Icon(Icons.close),
            tooltip: '閉じる',
            onPressed: () => Navigator.of(context).pop(),
          ),
          title: Text(_title, overflow: TextOverflow.ellipsis),
          actions: [
            IconButton(
              icon: const Icon(Icons.open_in_browser),
              tooltip: 'ブラウザで開く',
              onPressed: _openInBrowser,
            ),
          ],
          bottom: _progress < 1
              ? PreferredSize(
                  preferredSize: const Size.fromHeight(2),
                  child: LinearProgressIndicator(value: _progress, minHeight: 2),
                )
              : null,
        ),
        body: SafeArea(
          top: false,
          child: InAppWebView(
            initialUrlRequest: URLRequest(url: WebUri.uri(widget.url)),
            initialSettings: InAppWebViewSettings(
              useShouldOverrideUrlLoading: true,
              allowsBackForwardNavigationGestures: true,
              supportZoom: true,
              builtInZoomControls: true,
              displayZoomControls: false,
            ),
            onWebViewCreated: (c) => _controller = c,
            onTitleChanged: (_, title) {
              if (title != null && title.isNotEmpty && mounted) {
                setState(() => _title = title);
              }
            },
            onProgressChanged: (_, p) {
              if (mounted) setState(() => _progress = p / 100);
            },
            shouldOverrideUrlLoading: (controller, action) async {
              final uri = action.request.url;
              if (uri == null) return NavigationActionPolicy.ALLOW;
              final decision = classifyNavigation(
                uri,
                isMainFrame: action.isForMainFrame,
                newWindow: false,
                appHosts: widget.appHosts,
              );
              if (decision == LinkAction.openExternal) {
                await launchUrl(uri, mode: LaunchMode.externalApplication);
                return NavigationActionPolicy.CANCEL;
              }
              return NavigationActionPolicy.ALLOW;
            },
          ),
        ),
      ),
    );
  }
}
