import 'package:test/test.dart';
import 'package:dub_api_client/dub_api_client.dart';


/// tests for HealthApi
void main() {
  final instance = DubApiClient().getHealthApi();

  group(HealthApi, () {
    // Gateway liveness probe
    //
    //Future<GatewayHealth200Response> gatewayHealth() async
    test('test gatewayHealth', () async {
      // TODO
    });

  });
}
