import 'package:dio/dio.dart';

import '../config.dart';
import 'gantt_models.dart';
import 'gateway_client.dart';
import 'models.dart';

/// Thin wrapper over the shared [GatewayClient] for the gantt-service segment
/// (`/api/v1/gantt`). Reuses the gateway's authenticated dio (cookie session),
/// so there is no separate auth path.
///
/// Contract discipline: the query parameter is spelled **`eventId`** exactly as
/// `docs/openapi/gantt-service.yaml` declares — never `event`. (The web side
/// once shipped a `?event` vs `?eventId` mismatch; keeping the wire name literal
/// here is deliberate.)
class GanttApi {
  const GanttApi(this._client);

  final GatewayClient _client;

  Dio get _dio => _client.dio;
  String get _p => AppConfig.apiPrefix;

  /// GET /api/v1/gantt?eventId= — the chart read model (rows + dependencies).
  Future<GanttChartDTO> chart(String eventId) async {
    final res = await _dio.get<Map<String, dynamic>>(
      '$_p/gantt',
      queryParameters: {'eventId': eventId},
    );
    _throwIfError(res);
    return GanttChartDTO.fromJson(res.data!);
  }

  /// GET /api/v1/gantt/views?eventId= — the caller's saved view state.
  Future<GanttViewState> view(String eventId) async {
    final res = await _dio.get<Map<String, dynamic>>(
      '$_p/gantt/views',
      queryParameters: {'eventId': eventId},
    );
    _throwIfError(res);
    return GanttViewState.fromJson(res.data!);
  }

  /// PUT /api/v1/gantt/views?eventId= — upsert the caller's view state.
  Future<GanttViewState> putView(
    String eventId, {
    required GanttZoom zoom,
    required List<String> collapsedTaskIds,
    List<String>? orderedTaskIds,
  }) async {
    final res = await _dio.put<Map<String, dynamic>>(
      '$_p/gantt/views',
      queryParameters: {'eventId': eventId},
      data: {
        'zoom': zoom.wire,
        'collapsedTaskIds': collapsedTaskIds,
        if (orderedTaskIds != null) 'orderedTaskIds': orderedTaskIds,
      },
    );
    _throwIfError(res);
    return GanttViewState.fromJson(res.data!);
  }

  /// PATCH /api/v1/gantt/rows/{taskId} — persist a leaf row's schedule window
  /// (bar move/resize). `startsAt`/`endsAt` are ISO8601 UTC or null.
  Future<GanttRow> patchRow(
    String taskId, {
    required DateTime? startsAt,
    required DateTime? endsAt,
  }) async {
    final res = await _dio.patch<Map<String, dynamic>>(
      '$_p/gantt/rows/$taskId',
      data: {
        'startsAt': startsAt?.toUtc().toIso8601String(),
        'endsAt': endsAt?.toUtc().toIso8601String(),
      },
    );
    _throwIfError(res);
    return GanttRow.fromJson(res.data!);
  }

  void _throwIfError(Response<dynamic> res) {
    final status = res.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      throw DubApiException.fromResponse(res.data, statusCode: status);
    }
  }
}
