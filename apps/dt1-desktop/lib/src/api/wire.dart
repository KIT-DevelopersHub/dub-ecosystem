/// Desktop wire descriptor — the "4th face" of the wire-contract check
/// (docs/desktop/_dart-client-generation.md → Deferred #1; the mechanism in
/// docs/api-contracts/_wire-contract-enforcement.md).
///
/// The desktop reaches per-service reads through the gateway's transparent
/// proxy, so their query-parameter names are not covered by the generated
/// gateway client. This descriptor is the ONE place the desktop declares those
/// keys, and every proxy repository builds its query FROM here — it never writes
/// a bare literal like `?event=`. A Node reconciliation test
/// (`packages/e2e-smoke/test/desktop-wire.test.ts`) reads the exported form of
/// this descriptor and asserts each operation's keys are a subset of the
/// matching `<SVC>_WIRE` in `@dub/types`. Reintroducing the gantt `?event=` bug
/// on the Dart side therefore turns CI red — the same guard the web client has.
///
/// operationId keys mirror the `@dub/types` descriptors (getGantt, listInbox,
/// listEvents) so the reconciliation can match by id.
library;

/// One proxied read the desktop issues through the gateway.
class WireOp {
  const WireOp({required this.method, required this.path, required this.query});

  final String method;

  /// Service-relative path (matches the `<SVC>_WIRE` path in @dub/types). The
  /// gateway prefix + segment are added by [gatewayPath].
  final String path;

  /// Query-parameter names, in declaration order.
  final List<String> query;
}

/// The desktop's declared proxied endpoints, keyed by operationId.
const Map<String, WireOp> kDesktopWire = {
  // gantt-service (GANTT_WIRE.getGantt → query ['eventId'])
  'getGantt': WireOp(method: 'GET', path: '/gantt', query: ['eventId']),
  // notification (NOTIFICATION_WIRE.listInbox → query ['cursor','limit','unreadOnly'])
  'listInbox': WireOp(method: 'GET', path: '/inbox', query: ['unreadOnly', 'limit']),
  // event-service (EVENT_WIRE.listEvents → query ['cursor','limit','phase',...])
  'listEvents': WireOp(method: 'GET', path: '/events', query: ['limit']),
  // task-service (no TS `<SVC>_WIRE` yet; keys mirror ListTasksQuery in @dub/types)
  'listTasks': WireOp(method: 'GET', path: '/tasks', query: ['eventId', 'assigneeId']),
};

/// Build a `?a=..&b=..` query string from a wire op, dropping null values, so a
/// repository never hand-writes a key. Values are URL-encoded.
String buildQuery(WireOp op, Map<String, String?> values) {
  final parts = <String>[];
  for (final key in op.query) {
    final v = values[key];
    if (v != null && v.isNotEmpty) {
      parts.add('$key=${Uri.encodeQueryComponent(v)}');
    }
  }
  return parts.isEmpty ? '' : '?${parts.join('&')}';
}
