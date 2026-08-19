import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import 'notifications_models.dart';

/// Notifications feature API. Wraps the shared [ApiClient] — the feature owns
/// its endpoints; the shared client stays generic.
class NotificationsApi {
  NotificationsApi(this._client);

  final ApiClient _client;

  /// GET /api/v1/notifications/inbox — the caller's notification inbox.
  Future<PaginatedInbox> inbox({int limit = 50, bool unreadOnly = false}) async {
    final json = await _client.getJson(
      '/notifications/inbox',
      query: {
        'limit': limit,
        if (unreadOnly) 'unreadOnly': true,
      },
    );
    return PaginatedInbox.fromJson(json);
  }
}

final notificationsApiProvider = FutureProvider<NotificationsApi>((ref) async {
  final client = await ref.watch(apiClientProvider.future);
  return NotificationsApi(client);
});

/// The caller's notification inbox (first page). Auto-refetches whenever the
/// shared client is (re)created.
final inboxProvider = FutureProvider<PaginatedInbox>((ref) async {
  final api = await ref.watch(notificationsApiProvider.future);
  return api.inbox(limit: 50);
});
