import 'package:test/test.dart';
import 'package:dub_api_client/dub_api_client.dart';


/// tests for ProxyApi
void main() {
  final instance = DubApiClient().getProxyApi();

  group(ProxyApi, () {
    // Transparent proxy to a backing service
    //
    // Catch-all for every /api/v1/<segment>/_* request the gateway does not own itself. Applies to all HTTP methods (GET/POST/PUT/PATCH/DELETE) — one operation documents the shared behaviour. Resolves the route, applies guards (WebSocket-upgrade rejected as 400, body cap, internal-only sub-paths 404'd), runs a one-shot session verify for auth:required segments, then forwards with x-dub-request-id + x-dub-user-id. Per-service request/response schemas live in that service's own spec. See each <service>.yaml.
    //
    //Future proxyRequest(String segment, String path) async
    test('test proxyRequest', () async {
      // TODO
    });

  });
}
