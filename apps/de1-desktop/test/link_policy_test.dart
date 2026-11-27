import 'package:dub_desktop/mobile/link_policy.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const hosts = {'app.example.dev', 'api.example.dev'};

  LinkAction classify(String url, {bool mainFrame = true, bool newWindow = false}) =>
      classifyNavigation(
        Uri.parse(url),
        isMainFrame: mainFrame,
        newWindow: newWindow,
        appHosts: hosts,
      );

  test('Dub pages stay in the WebView', () {
    expect(classify('https://app.example.dev/chat'), LinkAction.allow);
    expect(classify('https://API.example.dev/api/v1/x'), LinkAction.allow);
  });

  test('other sites open in the OS browser', () {
    expect(classify('https://github.com/x'), LinkAction.openExternal);
    expect(classify('http://example.com'), LinkAction.openExternal);
  });

  test('mailto / tel / app links go to the OS', () {
    expect(classify('mailto:info@example.com'), LinkAction.openExternal);
    expect(classify('tel:0120000000'), LinkAction.openExternal);
    expect(classify('slack://open'), LinkAction.openExternal);
  });

  test('in-page schemes are never handed off', () {
    expect(classify('about:blank'), LinkAction.allow);
    expect(classify('blob:https://app.example.dev/1234'), LinkAction.allow);
    expect(classify('data:text/plain,hi'), LinkAction.allow);
  });

  test('iframes keep their own navigation', () {
    expect(classify('https://www.youtube.com/embed/x', mainFrame: false), LinkAction.allow);
  });

  test('new windows: Dub pages in the in-app viewer, others in the browser', () {
    expect(classify('https://api.example.dev/files/1', newWindow: true),
        LinkAction.openInAppViewer);
    expect(classify('https://maps.google.com', newWindow: true), LinkAction.openExternal);
  });

  test('default hosts come from the configured origins', () {
    final hosts = defaultAppHosts();
    expect(hosts, contains('dub-fe2-app-shell.developershub-site.workers.dev'));
    expect(hosts, contains('dub-api-gateway.developershub-site.workers.dev'));
  });
}
