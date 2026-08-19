import 'package:dio/dio.dart';

import '../config.dart';
import 'gateway_client.dart';
import 'mail_models.dart';

/// Thin, typed wrapper over the shared [GatewayClient] for the mail-gateway
/// external segment (`/api/v1/mail/...`, see `docs/openapi/mail-gateway.yaml`).
///
/// It reuses the gateway's authenticated (cookie-carrying) dio and its
/// `@dub/errors` envelope decoding, so mail requests ride the exact same
/// browser-parity session as the rest of the app. Reads require `mail:read`;
/// compose requires `mail:send` (enforced server-side).
class MailApi {
  MailApi(this._client);

  final GatewayClient _client;

  Dio get _dio => _client.authedDio;

  /// `/api/v1/mail` — the public mail segment on the gateway.
  String get _p => '${AppConfig.apiPrefix}/mail';

  /// GET /api/v1/mail/messages — a page of inbound messages. Optionally scoped
  /// to a thread. Cursor pagination (opaque cursor + nextCursor).
  Future<PaginatedMailMessages> listMessages({
    String? cursor,
    int limit = 50,
    String? threadId,
  }) async {
    final res = await _dio.get<Map<String, dynamic>>(
      '$_p/messages',
      queryParameters: {
        'limit': limit,
        if (cursor != null) 'cursor': cursor,
        if (threadId != null) 'threadId': threadId,
      },
    );
    _client.throwIfError(res);
    return PaginatedMailMessages.fromJson(res.data!);
  }

  /// GET /api/v1/mail/messages/{id} — a single inbound message.
  Future<MailMessage> getMessage(String id) async {
    final res = await _dio.get<Map<String, dynamic>>('$_p/messages/$id');
    _client.throwIfError(res);
    return MailMessage.fromJson(res.data!);
  }

  /// GET /api/v1/mail/threads/{id} — a thread's messages (the reading pane's
  /// conversation view).
  Future<MailThread> getThread(String id) async {
    final res = await _dio.get<Map<String, dynamic>>('$_p/threads/$id');
    _client.throwIfError(res);
    return MailThread.fromJson(res.data!);
  }

  /// GET /api/v1/mail/mailboxes — managed mailboxes (requires `mail:admin`).
  Future<MailboxList> listMailboxes() async {
    final res = await _dio.get<Map<String, dynamic>>('$_p/mailboxes');
    _client.throwIfError(res);
    return MailboxList.fromJson(res.data!);
  }

  /// POST /api/v1/mail/outbox — user-facing compose + send (requires
  /// `mail:send`). The desktop mail slice stops at "save draft" and never calls
  /// this; it exists so a real send is a one-line wiring change later. An
  /// optional idempotency key guards against double-send.
  Future<SendMailResponse> compose(
    SendMailRequest request, {
    String? idempotencyKey,
  }) async {
    final res = await _dio.post<Map<String, dynamic>>(
      '$_p/outbox',
      data: request.toJson(),
      options: idempotencyKey == null
          ? null
          : Options(headers: {'idempotency-key': idempotencyKey}),
    );
    _client.throwIfError(res);
    return SendMailResponse.fromJson(res.data!);
  }
}
