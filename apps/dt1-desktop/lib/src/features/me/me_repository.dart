import 'package:dub_api_client/dub_api_client.dart';

/// Thin repository over the generated GatewayApi for the `/me` composition.
///
/// Feature code depends on this, not on the generated client directly, so the
/// generated surface can be regenerated freely without rippling into widgets.
class MeRepository {
  MeRepository(this._client);

  final DubApiClient _client;

  /// GET /api/v1/me — current user, org, permissions, session expiry.
  Future<MeResponse> fetchMe() async {
    final res = await _client.getGatewayApi().getMe();
    final me = res.data;
    if (me == null) {
      throw StateError('gateway returned an empty /me body');
    }
    return me;
  }
}
