import '../../api/proxy_repository.dart';
import '../../api/wire.dart';

/// One event (event-service.yaml `DubEvent`). Keys match the spec.
class EventItem {
  EventItem({
    required this.id,
    required this.title,
    required this.phase,
    required this.startsAt,
    required this.endsAt,
  });

  final String id;
  final String title;
  final String phase; // draft | published | ...
  final DateTime? startsAt;
  final DateTime? endsAt;

  factory EventItem.fromJson(Map<String, Object?> j) => EventItem(
        id: asString(j['id']),
        title: asString(j['title']),
        phase: asString(j['phase']),
        startsAt: asDate(j['startsAt']),
        endsAt: asDate(j['endsAt']),
      );
}

/// Reads the org's events through the gateway proxy (`GET /api/v1/events`).
class EventsRepository {
  EventsRepository(this._proxy);

  final ProxyClient _proxy;

  Future<List<EventItem>> fetchEvents({int limit = 50}) async {
    final op = kDesktopWire['listEvents']!;
    final query = buildQuery(op, {'limit': '$limit'});
    final body = await _proxy.getJson('/api/v1/events$query');
    return asItems(body).map(EventItem.fromJson).toList();
  }
}
