// A tiny, contract-faithful stand-in for the api-gateway + auth-service, used
// to run the desktop vertical slice locally without spinning the full
// Cloudflare Workers stack. It implements exactly the three routes the slice
// touches, with the real wire shapes from docs/openapi/*.yaml.
//
//   POST /api/v1/auth/password/login  -> Set-Cookie dub_session + {token,session}
//   GET  /api/v1/me                   -> MeResponse         (needs dub_session)
//   GET  /api/v1/notifications/inbox  -> PaginatedInbox     (needs dub_session)
//   POST /api/v1/auth/logout          -> {ok:true}
//
// Run:  dart run tool/mock_gateway.dart [port]   (default port 8799)
//
// NOT production. This exists only to exercise the client wiring.
import 'dart:convert';
import 'dart:io';

const _sessionToken = 'mock-session-token-abc123';
const _allowedDomain = 'developershub.jp';

Future<void> main(List<String> args) async {
  final port = args.isNotEmpty ? int.parse(args.first) : 8799;
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, port);
  stdout.writeln('mock gateway listening on http://127.0.0.1:$port');

  await for (final req in server) {
    try {
      await _route(req);
    } catch (e) {
      _json(req, 500, {
        'error': {
          'code': 'INTERNAL',
          'message': '$e',
          'retryable': false,
        }
      });
    }
  }
}

Future<void> _route(HttpRequest req) async {
  final path = req.uri.path;
  final method = req.method;
  stdout.writeln('[${DateTime.now().toIso8601String()}] $method $path');

  if (method == 'POST' && path == '/api/v1/auth/password/login') {
    return _login(req);
  }
  if (method == 'POST' && path == '/api/v1/auth/logout') {
    return _json(req, 200, {'ok': true});
  }
  if (method == 'GET' && path == '/healthz') {
    return _json(req, 200, {'ok': true});
  }

  // Everything below requires a valid session cookie.
  if (!_hasSession(req)) {
    return _json(req, 401, {
      'error': {
        'code': 'UNAUTHENTICATED',
        'message': 'missing/invalid session',
        'retryable': false,
      }
    });
  }

  if (method == 'GET' && path == '/api/v1/me') {
    return _json(req, 200, _me());
  }
  if (method == 'GET' && path == '/api/v1/notifications/inbox') {
    return _json(req, 200, _inbox());
  }

  // --- gantt-service segment (docs/openapi/gantt-service.yaml) ---
  // Query param is `eventId` (NOT `event`) per the contract.
  if (method == 'GET' && path == '/api/v1/gantt') {
    final eventId = req.uri.queryParameters['eventId'];
    if (eventId == null || eventId.isEmpty) {
      return _json(req, 400, {
        'error': {
          'code': 'VALIDATION_FAILED',
          'message': 'eventId is required',
          'retryable': false,
        }
      });
    }
    return _json(req, 200, _ganttChart(eventId));
  }
  if (method == 'GET' && path == '/api/v1/gantt/dependencies') {
    final eventId = req.uri.queryParameters['eventId'] ?? 'evt_conf';
    final chart = _ganttChart(eventId);
    return _json(req, 200, {
      'eventId': eventId,
      'dependencies': chart['dependencies'],
    });
  }
  if (path == '/api/v1/gantt/views') {
    final eventId = req.uri.queryParameters['eventId'] ?? 'evt_conf';
    if (method == 'GET') {
      return _json(req, 200, _ganttView(eventId));
    }
    if (method == 'PUT') {
      final body = await utf8.decoder.bind(req).join();
      final data = body.isEmpty
          ? <String, dynamic>{}
          : jsonDecode(body) as Map<String, dynamic>;
      return _json(req, 200, {
        'eventId': eventId,
        'zoom': (data['zoom'] as String?) ?? 'week',
        'collapsedTaskIds': data['collapsedTaskIds'] ?? <String>[],
        if (data['orderedTaskIds'] != null)
          'orderedTaskIds': data['orderedTaskIds'],
      });
    }
  }
  if (method == 'PATCH' && path.startsWith('/api/v1/gantt/rows/')) {
    final taskId = path.substring('/api/v1/gantt/rows/'.length);
    final body = await utf8.decoder.bind(req).join();
    final data = body.isEmpty
        ? <String, dynamic>{}
        : jsonDecode(body) as Map<String, dynamic>;
    // Echo back an updated row reflecting the requested window.
    final base = _ganttRowsById()[taskId];
    if (base == null) {
      return _json(req, 404, {
        'error': {'code': 'NOT_FOUND', 'message': 'no such task', 'retryable': false}
      });
    }
    return _json(req, 200, {
      ...base,
      'startsAt': data['startsAt'],
      'endsAt': data['endsAt'],
    });
  }

  _json(req, 404, {
    'error': {'code': 'NOT_FOUND', 'message': 'no route', 'retryable': false}
  });
}

Future<void> _login(HttpRequest req) async {
  final body = await utf8.decoder.bind(req).join();
  final data = body.isEmpty
      ? <String, dynamic>{}
      : jsonDecode(body) as Map<String, dynamic>;
  final email = (data['email'] as String?)?.trim() ?? '';
  final password = (data['password'] as String?) ?? '';

  if (!email.contains('@')) {
    return _json(req, 400, {
      'error': {
        'code': 'VALIDATION_FAILED',
        'message': 'invalid email',
        'retryable': false,
      }
    });
  }
  if (!email.endsWith('@$_allowedDomain')) {
    return _json(req, 403, {
      'error': {
        'code': 'AUTH_DOMAIN_NOT_ALLOWED',
        'message': 'email is not on the allowed company login domain',
        'retryable': false,
      }
    });
  }
  if (password.isEmpty) {
    return _json(req, 401, {
      'error': {
        'code': 'AUTH_INVALID_CREDENTIALS',
        'message': 'unknown email or wrong password',
        'retryable': false,
      }
    });
  }

  final expires = DateTime.now()
      .add(const Duration(hours: 12))
      .millisecondsSinceEpoch;
  req.response.headers.add(
    HttpHeaders.setCookieHeader,
    'dub_session=$_sessionToken; Path=/; HttpOnly',
  );
  _json(req, 200, {
    'token': _sessionToken,
    'session': {
      'userId': 'usr_demo',
      'client': 'web',
      'sessionExpiresAt': expires,
    },
  });
}

bool _hasSession(HttpRequest req) {
  return req.cookies.any((c) => c.name == 'dub_session' && c.value.isNotEmpty);
}

Map<String, dynamic> _me() => {
      'user': {
        'id': 'usr_demo',
        'displayName': 'デモ 太郎',
        'avatarUrl': null,
      },
      'orgId': 'org_devhub',
      'permissions': ['notif:inbox:self', 'chat:read'],
      'sessionExpiresAt':
          DateTime.now().add(const Duration(hours: 12)).millisecondsSinceEpoch,
    };

Map<String, dynamic> _inbox() {
  String iso(Duration ago) =>
      DateTime.now().toUtc().subtract(ago).toIso8601String();
  return {
    'items': [
      {
        'id': 'ntf_1',
        'type': 'deploy',
        'title': '使用量ダッシュボードを全メンバーに開放しました',
        'body': '本番デプロイが完了し、使用量ダッシュボードが全員に公開されました。',
        'readAt': null,
        'createdAt': iso(const Duration(minutes: 8)),
        'resourceType': 'deploy',
        'resourceId': 'dep_123',
      },
      {
        'id': 'ntf_2',
        'type': 'chat_mention',
        'title': '#general であなたがメンションされました',
        'body': '@デモ太郎 明日のリリースレビューお願いします！',
        'readAt': null,
        'createdAt': iso(const Duration(hours: 1)),
        'resourceType': 'chat_channel',
        'resourceId': 'chn_general',
      },
      {
        'id': 'ntf_3',
        'type': 'task_assigned',
        'title': 'タスクが割り当てられました: ガント DnD の回帰確認',
        'body': 'イテレーション 12 のタスクがあなたに割り当てられました。',
        'readAt': iso(const Duration(hours: 5)),
        'createdAt': iso(const Duration(hours: 6)),
        'resourceType': 'task',
        'resourceId': 'tsk_88',
      },
      {
        'id': 'ntf_4',
        'type': 'event_phase',
        'title': '北陸ITカンファレンスが「準備中」に移行しました',
        'body': 'イベントのフェーズが planning から preparing に変わりました。',
        'readAt': iso(const Duration(days: 1)),
        'createdAt': iso(const Duration(days: 1, hours: 2)),
        'resourceType': 'event',
        'resourceId': 'evt_conf',
      },
    ],
    'nextCursor': null,
  };
}

// --- gantt mock data ---------------------------------------------------------

/// A small, contract-faithful gantt anchored around "today" so the bars always
/// land in the visible window. FS dependencies chain the rows.
List<Map<String, dynamic>> _ganttRows() {
  String day(int offset) {
    final base = DateTime.now().toUtc();
    final d = DateTime.utc(base.year, base.month, base.day)
        .add(Duration(days: offset));
    return d.toIso8601String();
  }

  return [
    {
      'taskId': 'tsk_plan',
      'title': '企画・要件定義',
      'startsAt': day(-3),
      'endsAt': day(2),
      'progressPercent': 100,
      'assigneeId': 'usr_demo',
    },
    {
      'taskId': 'tsk_design',
      'title': '会場・登壇者調整',
      'startsAt': day(3),
      'endsAt': day(9),
      'progressPercent': 60,
      'assigneeId': 'usr_demo',
    },
    {
      'taskId': 'tsk_build',
      'title': 'サイト・受付システム構築',
      'startsAt': day(6),
      'endsAt': day(16),
      'progressPercent': 25,
      'assigneeId': 'usr_demo',
    },
    {
      'taskId': 'tsk_promo',
      'title': '告知・集客',
      'startsAt': day(10),
      'endsAt': day(20),
      'progressPercent': 10,
      'assigneeId': null,
    },
    {
      'taskId': 'tsk_run',
      'title': '当日運営',
      'startsAt': day(21),
      'endsAt': day(22),
      'progressPercent': 0,
      'assigneeId': null,
    },
  ];
}

Map<String, Map<String, dynamic>> _ganttRowsById() => {
      for (final r in _ganttRows()) r['taskId'] as String: r,
    };

Map<String, dynamic> _ganttChart(String eventId) => {
      'eventId': eventId,
      'rows': _ganttRows(),
      'dependencies': [
        {
          'id': 'dep_1',
          'fromTaskId': 'tsk_plan',
          'toTaskId': 'tsk_design',
          'type': 'FS',
          'lagDays': 0,
        },
        {
          'id': 'dep_2',
          'fromTaskId': 'tsk_design',
          'toTaskId': 'tsk_build',
          'type': 'FS',
          'lagDays': 0,
        },
        {
          'id': 'dep_3',
          'fromTaskId': 'tsk_build',
          'toTaskId': 'tsk_run',
          'type': 'FS',
          'lagDays': 0,
        },
        {
          'id': 'dep_4',
          'fromTaskId': 'tsk_promo',
          'toTaskId': 'tsk_run',
          'type': 'FS',
          'lagDays': 0,
        },
      ],
    };

Map<String, dynamic> _ganttView(String eventId) => {
      'eventId': eventId,
      'zoom': 'week',
      'collapsedTaskIds': <String>[],
    };

void _json(HttpRequest req, int status, Map<String, dynamic> body) {
  req.response
    ..statusCode = status
    ..headers.contentType = ContentType.json
    ..headers.add('x-dub-request-id', 'mock-${DateTime.now().microsecondsSinceEpoch}')
    ..write(jsonEncode(body));
  req.response.close();
}
