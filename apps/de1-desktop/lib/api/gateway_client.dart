import 'dart:io';

import 'package:cookie_jar/cookie_jar.dart';
import 'package:dio/dio.dart';
import 'package:dio_cookie_manager/dio_cookie_manager.dart';

import '../config.dart';
import 'models.dart';
import 'task_models.dart';

/// Thin client over the shared api-gateway. Web-parity auth: the auth-service
/// login response sets `Set-Cookie: dub_session=...`, the [CookieManager]
/// captures it into a persistent jar, and every subsequent gateway request
/// carries it automatically — exactly like a browser. No bearer-token plumbing,
/// no assumption about token/cookie equivalence.
class GatewayClient {
  GatewayClient._(this._dio, this._jar);

  final Dio _dio;
  final PersistCookieJar _jar;

  static Future<GatewayClient> create() async {
    final jar = PersistCookieJar(storage: FileStorage(_cookieDir()));
    final dio = Dio(
      BaseOptions(
        baseUrl: AppConfig.gatewayBaseUrl,
        connectTimeout: const Duration(seconds: 15),
        receiveTimeout: const Duration(seconds: 20),
        // We inspect non-2xx bodies ourselves to map the @dub/errors envelope.
        validateStatus: (_) => true,
        headers: {'accept': 'application/json'},
      ),
    );
    dio.interceptors.add(CookieManager(jar));
    return GatewayClient._(dio, jar);
  }

  /// Persistent cookie store location. Uses the OS home dir (HOME on
  /// macOS/Linux, USERPROFILE on Windows), falling back to a temp dir.
  /// Production should swap this for path_provider's applicationSupport dir.
  static String _cookieDir() {
    final env = Platform.environment;
    final home = env['HOME'] ?? env['USERPROFILE'] ?? Directory.systemTemp.path;
    final dir = Directory('$home/.dub_desktop/cookies');
    dir.createSync(recursive: true);
    return dir.path;
  }

  String get _p => AppConfig.apiPrefix;

  /// POST /api/v1/auth/password/login — company email + password.
  Future<TokenSessionResponse> login(String email, String password) async {
    final res = await _dio.post<Map<String, dynamic>>(
      '$_p/auth/password/login',
      data: {'email': email, 'password': password},
    );
    _throwIfError(res);
    return TokenSessionResponse.fromJson(res.data!);
  }

  /// GET /api/v1/me — current user, org, permissions, session expiry.
  Future<MeResponse> me() async {
    final res = await _dio.get<Map<String, dynamic>>('$_p/me');
    _throwIfError(res);
    return MeResponse.fromJson(res.data!);
  }

  /// GET /api/v1/notifications/inbox — the caller's notification inbox.
  Future<PaginatedInbox> inbox({int limit = 50, bool unreadOnly = false}) async {
    final res = await _dio.get<Map<String, dynamic>>(
      '$_p/notifications/inbox',
      queryParameters: {
        'limit': limit,
        if (unreadOnly) 'unreadOnly': true,
      },
    );
    _throwIfError(res);
    return PaginatedInbox.fromJson(res.data!);
  }

  // --- Tasks (task-service via gateway `/api/v1/tasks`) ---

  /// GET /api/v1/tasks — a page of tasks. Optional filters mirror the contract.
  Future<PaginatedTasks> listTasks({
    int limit = 50,
    String? cursor,
    String? eventId,
    String? assigneeId,
    List<TaskStatus>? status,
    bool includeArchived = false,
  }) async {
    final res = await _dio.get<Map<String, dynamic>>(
      '$_p/tasks',
      queryParameters: {
        'limit': limit,
        if (cursor != null) 'cursor': cursor,
        if (eventId != null) 'eventId': eventId,
        if (assigneeId != null) 'assigneeId': assigneeId,
        if (status != null && status.isNotEmpty)
          'status': status.map((s) => s.wire).toList(),
        if (includeArchived) 'includeArchived': true,
      },
    );
    _throwIfError(res);
    return PaginatedTasks.fromJson(res.data!);
  }

  /// GET /api/v1/tasks/{id} — a single task (used to reconcile after a write).
  Future<Task> getTask(String id) async {
    final res = await _dio.get<Map<String, dynamic>>('$_p/tasks/$id');
    _throwIfError(res);
    return Task.fromJson(res.data!);
  }

  /// PATCH /api/v1/tasks/{id} — optimistic-locked update. [version] is the
  /// task's current version; a mismatch yields 409 (CONFLICT). Only the passed
  /// fields are sent. Pass [clearAssignee] to explicitly unassign (null).
  Future<Task> updateTask(
    String id, {
    required int version,
    TaskStatus? status,
    TaskPriority? priority,
    String? assigneeId,
    bool clearAssignee = false,
  }) async {
    final res = await _dio.patch<Map<String, dynamic>>(
      '$_p/tasks/$id',
      data: {
        'version': version,
        if (status != null) 'status': status.wire,
        if (priority != null) 'priority': priority.wire,
        if (clearAssignee)
          'assigneeId': null
        else if (assigneeId != null)
          'assigneeId': assigneeId,
      },
    );
    _throwIfError(res);
    return Task.fromJson(res.data!);
  }

  /// GET /api/v1/identity/users — roster for the assignee picker. Requires
  /// `identity:read`; callers that lack it get a 403 (handled by the caller,
  /// which falls back to showing the raw assignee id).
  Future<List<RosterUser>> listRosterUsers({int limit = 200, String? q}) async {
    final res = await _dio.get<Map<String, dynamic>>(
      '$_p/identity/users',
      queryParameters: {
        'limit': limit,
        if (q != null && q.isNotEmpty) 'q': q,
      },
    );
    _throwIfError(res);
    final items = res.data!['items'] as List<dynamic>? ?? const [];
    return items
        .map((e) => RosterUser.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  /// POST /api/v1/auth/logout — revoke the current session and clear cookies.
  Future<void> logout() async {
    try {
      await _dio.post('$_p/auth/logout');
    } finally {
      await _jar.deleteAll();
    }
  }

  void _throwIfError(Response<dynamic> res) {
    final status = res.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      throw DubApiException.fromResponse(res.data, statusCode: status);
    }
  }
}
