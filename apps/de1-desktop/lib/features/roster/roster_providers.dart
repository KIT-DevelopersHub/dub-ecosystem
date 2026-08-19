import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../state/auth.dart';
import 'roster_api.dart';
import 'roster_models.dart';

/// Roster API bound to the shared, async-initialised gateway client.
final rosterApiProvider = FutureProvider<RosterApi>((ref) async {
  final client = await ref.watch(gatewayClientProvider.future);
  return RosterApi(client);
});

/// The member roster: identity users joined with their role names.
///
/// Fetches users and roles together, builds a roleId -> name lookup, and
/// returns the joined view-models. This is the primary "メンバー名簿 + ロール表示".
final rosterMembersProvider = FutureProvider<List<RosterMember>>((ref) async {
  final api = await ref.watch(rosterApiProvider.future);
  final usersFuture = api.listUsers();
  final rolesFuture = api.listRoles();
  final users = await usersFuture;
  final roles = await rolesFuture;
  final roleNamesById = {for (final r in roles.items) r.id: r.name};
  return RosterMember.join(users.items, roleNamesById);
});

/// The Email Routing destination addresses ("メール名簿"). Kept separate from
/// [rosterMembersProvider] so an admin-only 403 here does not blank out the
/// member list — the view renders each section's own loading/error state.
final emailRoutingAddressesProvider =
    FutureProvider<List<EmailRoutingAddress>>((ref) async {
  final api = await ref.watch(rosterApiProvider.future);
  final list = await api.listEmailRoutingAddresses();
  return list.items;
});
