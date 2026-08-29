import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/models.dart';
import 'auth.dart';

/// The caller's notification inbox (first page). Auto-refetches whenever the
/// gateway client is (re)created.
final inboxProvider = FutureProvider<PaginatedInbox>((ref) async {
  final client = await ref.watch(gatewayClientProvider.future);
  return client.inbox(limit: 50);
});
