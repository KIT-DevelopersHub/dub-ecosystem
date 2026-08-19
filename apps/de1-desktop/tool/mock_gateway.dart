// A tiny, contract-faithful stand-in for the api-gateway + auth-service, used
// to run the desktop vertical slice locally without spinning the full
// Cloudflare Workers stack. It implements exactly the three routes the slice
// touches, with the real wire shapes from docs/openapi/*.yaml.
//
//   POST /api/v1/auth/password/login  -> Set-Cookie dub_session + {token,session}
//   GET  /api/v1/me                   -> MeResponse         (needs dub_session)
//   GET  /api/v1/notifications/inbox  -> PaginatedInbox     (needs dub_session)
//   POST /api/v1/auth/logout          -> {ok:true}
//   GET  /api/v1/chat/channels               -> ChannelList
//   GET  /api/v1/chat/messages?channelId=…   -> MessagePage
//   POST /api/v1/chat/messages               -> ChatMessage (fans out over WS)
//   POST /api/v1/chat/channels/{id}/read     -> {ok:true}
//   GET  /api/v1/chat/channels/{id}/ws-ticket-> WsTicketResponse (doUrl -> /ws/:id)
//   WS   /ws/{channelId}?ticket=…            -> realtime ChatRealtimeEvent stream
//
// The WS loop is a genuine loopback: posting a message broadcasts message.created
// to every socket in that channel, and ~1.5s after a socket connects the mock
// emits a demo inbound message from another user (proves live receive).
//
// Run:  dart run tool/mock_gateway.dart [port]   (default port 8799)
//
// NOT production. This exists only to exercise the client wiring.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

const _sessionToken = 'mock-session-token-abc123';
const _allowedDomain = 'developershub.jp';

int _port = 8799;

// --- in-memory chat state ---------------------------------------------------
final List<Map<String, dynamic>> _channels = [
  {'id': 'chn_general', 'name': 'general', 'createdAt': _isoNow()},
  {'id': 'chn_random', 'name': 'random', 'createdAt': _isoNow()},
  {'id': 'chn_dev', 'name': 'dev', 'createdAt': _isoNow()},
];
final Map<String, List<Map<String, dynamic>>> _messages = {
  'chn_general': [
    _msg('chn_general', 'usr_hana', 'おはようございます！今日のリリースレビュー 15:00 からです。'),
    _msg('chn_general', 'usr_demo', '了解です、資料まとめておきます。'),
  ],
  'chn_random': [
    _msg('chn_random', 'usr_ken', '近くにいい感じのコーヒー屋できたらしい☕'),
  ],
  'chn_dev': [
    _msg('chn_dev', 'usr_hana', 'ガントの DnD 回帰、E2E green になりました 🎉'),
  ],
};
final Map<String, Set<WebSocket>> _sockets = {};
int _msgSeq = 100;

Future<void> main(List<String> args) async {
  _port = args.isNotEmpty ? int.parse(args.first) : 8799;
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, _port);
  stdout.writeln('mock gateway listening on http://127.0.0.1:$_port');

  await for (final req in server) {
    try {
      // WebSocket realtime endpoint: /ws/<channelId>?ticket=… (gateway-bypassing).
      if (WebSocketTransformer.isUpgradeRequest(req) &&
          req.uri.path.startsWith('/ws/')) {
        await _handleWs(req);
        continue;
      }
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

  // ---- chat ----
  if (method == 'GET' && path == '/api/v1/chat/channels') {
    return _json(req, 200, {'items': _channels});
  }
  if (method == 'GET' && path == '/api/v1/chat/messages') {
    final channelId = req.uri.queryParameters['channelId'] ?? '';
    final items = _messages[channelId] ?? const [];
    return _json(req, 200, {'items': items, 'nextCursor': null});
  }
  if (method == 'POST' && path == '/api/v1/chat/messages') {
    return _postMessage(req);
  }
  final readMatch =
      RegExp(r'^/api/v1/chat/channels/([^/]+)/read$').firstMatch(path);
  if (method == 'POST' && readMatch != null) {
    return _json(req, 200, {'ok': true});
  }
  final ticketMatch =
      RegExp(r'^/api/v1/chat/channels/([^/]+)/ws-ticket$').firstMatch(path);
  if (method == 'GET' && ticketMatch != null) {
    final channelId = ticketMatch.group(1)!;
    final expires =
        DateTime.now().toUtc().add(const Duration(minutes: 2)).toIso8601String();
    return _json(req, 200, {
      'ticket': 'mock-ws-ticket',
      'doUrl': 'ws://127.0.0.1:$_port/ws/$channelId',
      'expiresAt': expires,
    });
  }

  _json(req, 404, {
    'error': {'code': 'NOT_FOUND', 'message': 'no route', 'retryable': false}
  });
}

Future<void> _postMessage(HttpRequest req) async {
  final raw = await utf8.decoder.bind(req).join();
  final data =
      raw.isEmpty ? <String, dynamic>{} : jsonDecode(raw) as Map<String, dynamic>;
  final channelId = (data['channelId'] as String?) ?? '';
  final body = (data['body'] as String?) ?? '';
  if (channelId.isEmpty || body.trim().isEmpty) {
    return _json(req, 400, {
      'error': {
        'code': 'VALIDATION_FAILED',
        'message': 'channelId and body are required',
        'retryable': false,
      }
    });
  }
  final message = _msg(channelId, 'usr_demo', body);
  _messages.putIfAbsent(channelId, () => []).add(message);
  _json(req, 201, message);
  // Fan out message.created to all sockets in the channel (web-parity RT).
  _broadcast(channelId, {
    'kind': 'message.created',
    'channelId': channelId,
    'messageId': message['id'],
    'authorId': message['authorId'],
    'body': message['body'],
    'at': message['createdAt'],
  });
}

Future<void> _handleWs(HttpRequest req) async {
  final match = RegExp(r'/ws/([^/?]+)').firstMatch(req.uri.path);
  final channelId = match != null ? match.group(1)! : '';
  final ws = await WebSocketTransformer.upgrade(req);
  stdout.writeln('[ws] connect channel=$channelId');
  final set = _sockets.putIfAbsent(channelId, () => <WebSocket>{})..add(ws);

  ws.listen(
    (data) {
      if (data == 'ping') ws.add('pong'); // liveness echo (matches ChatRoom DO)
    },
    onDone: () => set.remove(ws),
    onError: (_) => set.remove(ws),
    cancelOnError: true,
  );

  // Demo: a few seconds after connect, push an inbound message from another user
  // so the realtime path is visibly exercised with a single client.
  Timer(const Duration(milliseconds: 8000), () {
    if (!set.contains(ws)) return;
    final message =
        _msg(channelId, 'usr_hana', 'これはリアルタイム受信のデモです（WebSocket 経由）📡');
    _messages.putIfAbsent(channelId, () => []).add(message);
    _broadcast(channelId, {
      'kind': 'message.created',
      'channelId': channelId,
      'messageId': message['id'],
      'authorId': message['authorId'],
      'body': message['body'],
      'at': message['createdAt'],
    });
  });
}

void _broadcast(String channelId, Map<String, dynamic> event) {
  final set = _sockets[channelId];
  if (set == null) return;
  final data = jsonEncode(event);
  for (final ws in set.toList()) {
    try {
      ws.add(data);
    } catch (_) {
      set.remove(ws);
    }
  }
}

String _isoNow() => DateTime.now().toUtc().toIso8601String();

Map<String, dynamic> _msg(String channelId, String authorId, String body) => {
      'id': 'msg_${_msgSeq++}',
      'channelId': channelId,
      'authorId': authorId,
      'body': body,
      'createdAt': _isoNow(),
    };

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
