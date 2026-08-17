import 'package:dub_api_client/dub_api_client.dart';

/// Thin repository over the gateway's typed `/bff/home` composition (upcoming
/// events + unread notification count, with degraded upstreams surfaced as
/// `partialErrors` rather than failing the whole response). Uses the generated
/// built_value model — no hand-written wire.
class HomeRepository {
  HomeRepository(this._client);

  final DubApiClient _client;

  Future<BffHomeResponse> fetchHome() async {
    final res = await _client.getGatewayApi().getBffHome();
    final home = res.data;
    if (home == null) {
      throw StateError('gateway returned an empty /bff/home body');
    }
    return home;
  }
}
