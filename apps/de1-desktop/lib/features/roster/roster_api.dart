import '../../api/gateway_client.dart';
import 'roster_models.dart';

/// Roster feature's thin wrapper over the shared [GatewayClient]. It owns the
/// roster-specific routes + parsing so the shared client stays generic. All
/// traffic still goes through the single api-gateway contract.
class RosterApi {
  const RosterApi(this._client);

  final GatewayClient _client;

  /// GET /api/v1/identity/users — roster members (displayName, email, status,
  /// roleIds). `identity:read` required by the gateway.
  Future<PaginatedUsers> listUsers({
    int limit = 200,
    String? cursor,
    String? query,
  }) async {
    final json = await _client.getJson(
      '/identity/users',
      query: {
        'limit': limit,
        if (cursor != null) 'cursor': cursor,
        if (query != null && query.isNotEmpty) 'q': query,
      },
    );
    return PaginatedUsers.fromJson(json);
  }

  /// GET /api/v1/identity/roles — role catalog, used to resolve roleId -> name.
  Future<PaginatedRoles> listRoles({int limit = 200, String? cursor}) async {
    final json = await _client.getJson(
      '/identity/roles',
      query: {
        'limit': limit,
        if (cursor != null) 'cursor': cursor,
      },
    );
    return PaginatedRoles.fromJson(json);
  }

  /// GET /api/v1/mail/admin/email-routing/addresses — the Email Routing
  /// destination (forward-target) addresses = the "メール名簿". `mail:admin`
  /// required; non-admins get 403 and the UI degrades to just the member list.
  Future<EmailRoutingAddressList> listEmailRoutingAddresses() async {
    final json =
        await _client.getJson('/mail/admin/email-routing/addresses');
    return EmailRoutingAddressList.fromJson(json);
  }
}
