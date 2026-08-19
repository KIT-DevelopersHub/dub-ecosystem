import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/models.dart';
import 'auth.dart';

/// First page of events (`GET /api/v1/events`). Refetches whenever the gateway
/// client is (re)created.
final eventsProvider = FutureProvider<PaginatedEvents>((ref) async {
  final client = await ref.watch(gatewayClientProvider.future);
  return client.listEvents(limit: 50);
});

/// Detail (with actions) for a single event (`GET /api/v1/events/{id}`).
final eventDetailProvider =
    FutureProvider.family<EventDetail, String>((ref, id) async {
  final client = await ref.watch(gatewayClientProvider.future);
  return client.getEvent(id);
});
