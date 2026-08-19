// A tiny, contract-faithful stand-in for the api-gateway + auth-service, used
// to run the desktop vertical slice locally without spinning the full
// Cloudflare Workers stack. It implements exactly the three routes the slice
// touches, with the real wire shapes from docs/openapi/*.yaml.
//
//   POST /api/v1/auth/password/login  -> Set-Cookie dub_session + {token,session}
//   GET  /api/v1/me                   -> MeResponse         (needs dub_session)
//   POST /api/v1/me/password          -> {ok:true}          (needs dub_session)
//   GET  /api/v1/notifications/inbox  -> PaginatedInbox     (needs dub_session)
//   GET  /api/v1/events               -> PaginatedEvents    (needs dub_session)
//   GET  /api/v1/events/{id}          -> EventDetail        (needs dub_session)
//   GET  /api/v1/drive/files          -> PaginatedDriveFiles(needs dub_session)
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
  if (method == 'POST' && path == '/api/v1/me/password') {
    return _changePassword(req);
  }
  if (method == 'GET' && path == '/api/v1/notifications/inbox') {
    return _json(req, 200, _inbox());
  }
  if (method == 'GET' && path == '/api/v1/events') {
    return _json(req, 200, _events());
  }
  if (method == 'GET' && path.startsWith('/api/v1/events/')) {
    final id = path.substring('/api/v1/events/'.length);
    final detail = _eventDetail(id);
    if (detail == null) {
      return _json(req, 404, {
        'error': {'code': 'NOT_FOUND', 'message': 'no event', 'retryable': false}
      });
    }
    return _json(req, 200, detail);
  }
  if (method == 'GET' && path == '/api/v1/drive/files') {
    final folderId = req.uri.queryParameters['folderId'];
    return _json(req, 200, _driveFiles(folderId));
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

Future<void> _changePassword(HttpRequest req) async {
  final body = await utf8.decoder.bind(req).join();
  final data = body.isEmpty
      ? <String, dynamic>{}
      : jsonDecode(body) as Map<String, dynamic>;
  final current = (data['currentPassword'] as String?) ?? '';
  final next = (data['newPassword'] as String?) ?? '';
  if (current.isEmpty) {
    return _json(req, 401, {
      'error': {
        'code': 'AUTH_INVALID_CREDENTIALS',
        'message': 'current password is wrong',
        'retryable': false,
      }
    });
  }
  if (next.length < 8) {
    return _json(req, 400, {
      'error': {
        'code': 'VALIDATION_FAILED',
        'message': 'newPassword too short (min 8)',
        'retryable': false,
      }
    });
  }
  _json(req, 200, {'ok': true});
}

Map<String, dynamic> _events() {
  String? iso(Duration fromNow) =>
      DateTime.now().toUtc().add(fromNow).toIso8601String();
  return {
    'items': [
      {
        'id': 'evt_conf',
        'title': '北陸ITカンファレンス 2026',
        'phase': 'preparing',
        'startsAt': iso(const Duration(days: 21)),
      },
      {
        'id': 'evt_meetup',
        'title': 'リーダーズミートアップ #12',
        'phase': 'open',
        'startsAt': iso(const Duration(days: 5)),
      },
      {
        'id': 'evt_hackit',
        'title': 'Hackit 学生ハッカソン',
        'phase': 'closed',
        'startsAt': iso(const Duration(days: -30)),
      },
      {
        'id': 'evt_draft',
        'title': '未定の新規イベント',
        'phase': 'planning',
        'startsAt': null,
      },
    ],
    'nextCursor': null,
  };
}

Map<String, dynamic>? _eventDetail(String id) {
  final summaries = (_events()['items'] as List<dynamic>)
      .cast<Map<String, dynamic>>();
  final match = summaries.where((e) => e['id'] == id).toList();
  if (match.isEmpty) return null;
  final s = match.first;
  final now = DateTime.now().toUtc().toIso8601String();
  return {
    ...s,
    'orgId': 'org_devhub',
    'description': 'イベント「${s['title']}」の詳細です。運営メンバーで準備を進めています。',
    'endsAt': null,
    'archivedAt': null,
    'createdAt': now,
    'updatedAt': now,
    'version': 1,
    'actions': [
      {
        'id': 'act_reg',
        'eventId': id,
        'kind': 'registration',
        'title': '参加登録フォームの公開',
      },
      {
        'id': 'act_venue',
        'eventId': id,
        'kind': 'venue',
        'title': '会場の予約と設営',
      },
    ],
  };
}

Map<String, dynamic> _driveFiles(String? folderId) {
  String iso(Duration ago) =>
      DateTime.now().toUtc().subtract(ago).toIso8601String();
  const folderMime = 'application/vnd.google-apps.folder';
  final root = <Map<String, dynamic>>[
    {
      'id': 'fld_events',
      'name': 'イベント資料',
      'mimeType': folderMime,
      'modifiedAt': iso(const Duration(hours: 3)),
    },
    {
      'id': 'fld_ops',
      'name': '運営ドキュメント',
      'mimeType': folderMime,
      'modifiedAt': iso(const Duration(days: 1)),
    },
    {
      'id': 'file_budget',
      'name': '2026 予算.xlsx',
      'mimeType':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'modifiedAt': iso(const Duration(hours: 6)),
    },
    {
      'id': 'file_readme',
      'name': 'はじめに.pdf',
      'mimeType': 'application/pdf',
      'modifiedAt': iso(const Duration(days: 2)),
    },
  ];
  final child = <Map<String, dynamic>>[
    {
      'id': 'file_agenda',
      'name': '当日進行.docx',
      'mimeType':
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'modifiedAt': iso(const Duration(hours: 1)),
    },
    {
      'id': 'file_slides',
      'name': 'オープニング.pptx',
      'mimeType':
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'modifiedAt': iso(const Duration(hours: 4)),
    },
  ];
  return {
    'items': folderId == null ? root : child,
    'nextCursor': null,
  };
}

void _json(HttpRequest req, int status, Map<String, dynamic> body) {
  req.response
    ..statusCode = status
    ..headers.contentType = ContentType.json
    ..headers.add('x-dub-request-id', 'mock-${DateTime.now().microsecondsSinceEpoch}')
    ..write(jsonEncode(body));
  req.response.close();
}
