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

void _json(HttpRequest req, int status, Map<String, dynamic> body) {
  req.response
    ..statusCode = status
    ..headers.contentType = ContentType.json
    ..headers.add('x-dub-request-id', 'mock-${DateTime.now().microsecondsSinceEpoch}')
    ..write(jsonEncode(body));
  req.response.close();
}
