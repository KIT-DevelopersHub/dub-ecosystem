/// Dart mirrors of the mail wire contract (`docs/openapi/mail-gateway.yaml`,
/// typed in `@dub/types`). Hand-written for the mail feature slice, matching the
/// same "mirror the OpenAPI schema" convention as `api/models.dart`. The
/// external gateway segment is `/api/v1/mail/...`.
///
/// Contract notes (P0):
/// - `MailMessage` carries a `snippet`, not a full rendered body. The reading
///   pane therefore shows the thread conversation (`GET /mail/threads/{id}`),
///   whose messages each expose their snippet.
/// - There is no server-side read-state or folder model in the contract, so
///   "既読" and folder membership (受信トレイ/下書き) are tracked client-side
///   (see `state/mail.dart`). Drafts are local-only until an outbox endpoint is
///   wired for real sending.
library;

/// `MailAddress` — an email address with an optional display name.
class MailAddress {
  const MailAddress({required this.email, this.name});

  final String email;
  final String? name;

  /// `Name <email>` when a name is present, otherwise the bare address.
  String get display => (name != null && name!.isNotEmpty)
      ? '$name <$email>'
      : email;

  /// Best-effort short label for list rows (name, else the local part).
  String get shortLabel {
    if (name != null && name!.isNotEmpty) return name!;
    final at = email.indexOf('@');
    return at > 0 ? email.substring(0, at) : email;
  }

  factory MailAddress.fromJson(Map<String, dynamic> json) => MailAddress(
        email: json['email'] as String,
        name: json['name'] as String?,
      );

  Map<String, dynamic> toJson() => {
        'email': email,
        if (name != null && name!.isNotEmpty) 'name': name,
      };
}

/// `MailMessage` — one inbound message (list row + thread entry).
class MailMessage {
  const MailMessage({
    required this.id,
    required this.messageId,
    required this.threadId,
    required this.from,
    required this.to,
    required this.subject,
    required this.snippet,
    required this.receivedAt,
  });

  final String id;
  final String messageId;
  final String threadId;
  final MailAddress from;
  final List<MailAddress> to;
  final String subject;
  final String snippet;

  /// ISO8601 UTC.
  final String receivedAt;

  factory MailMessage.fromJson(Map<String, dynamic> json) => MailMessage(
        id: json['id'] as String,
        messageId: json['messageId'] as String,
        threadId: json['threadId'] as String,
        from: MailAddress.fromJson(json['from'] as Map<String, dynamic>),
        to: (json['to'] as List<dynamic>? ?? const [])
            .map((e) => MailAddress.fromJson(e as Map<String, dynamic>))
            .toList(),
        subject: json['subject'] as String,
        snippet: json['snippet'] as String,
        receivedAt: json['receivedAt'] as String,
      );
}

/// `MailThread` — a conversation: the thread id plus its messages.
class MailThread {
  const MailThread({required this.id, required this.messages});

  final String id;
  final List<MailMessage> messages;

  factory MailThread.fromJson(Map<String, dynamic> json) => MailThread(
        id: json['id'] as String,
        messages: (json['messages'] as List<dynamic>? ?? const [])
            .map((e) => MailMessage.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}

/// `PaginatedMailMessages` — a page of inbound messages with an opaque cursor.
class PaginatedMailMessages {
  const PaginatedMailMessages({required this.items, required this.nextCursor});

  final List<MailMessage> items;

  /// null = end of results.
  final String? nextCursor;

  factory PaginatedMailMessages.fromJson(Map<String, dynamic> json) =>
      PaginatedMailMessages(
        items: (json['items'] as List<dynamic>? ?? const [])
            .map((e) => MailMessage.fromJson(e as Map<String, dynamic>))
            .toList(),
        nextCursor: json['nextCursor'] as String?,
      );
}

/// `Mailbox` — a managed mailbox address (admin listing).
class Mailbox {
  const Mailbox({required this.address});

  final String address;

  factory Mailbox.fromJson(Map<String, dynamic> json) =>
      Mailbox(address: json['address'] as String);
}

/// `MailboxList` — the managed mailboxes.
class MailboxList {
  const MailboxList({required this.items});

  final List<Mailbox> items;

  factory MailboxList.fromJson(Map<String, dynamic> json) => MailboxList(
        items: (json['items'] as List<dynamic>? ?? const [])
            .map((e) => Mailbox.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}

/// `SendMailRequest` — user-facing compose payload (POST /mail/outbox). The
/// desktop slice stops at "save draft" and does not send, but the shape is
/// modelled faithfully so the outbox call can be wired later without a rewrite.
class SendMailRequest {
  const SendMailRequest({
    required this.to,
    required this.subject,
    required this.textBody,
    this.cc = const [],
    this.htmlBody,
    this.inReplyTo,
  });

  final List<MailAddress> to;
  final List<MailAddress> cc;
  final String subject;
  final String textBody;
  final String? htmlBody;
  final String? inReplyTo;

  Map<String, dynamic> toJson() => {
        'to': to.map((a) => a.toJson()).toList(),
        if (cc.isNotEmpty) 'cc': cc.map((a) => a.toJson()).toList(),
        'subject': subject,
        'textBody': textBody,
        if (htmlBody != null) 'htmlBody': htmlBody,
        if (inReplyTo != null) 'inReplyTo': inReplyTo,
      };
}

/// `SendMailResponse` — provider accept receipt (200/202 from /outbox).
class SendMailResponse {
  const SendMailResponse({
    required this.messageId,
    required this.provider,
    required this.acceptedAt,
  });

  final String messageId;
  final String provider;

  /// ISO8601 UTC.
  final String acceptedAt;

  factory SendMailResponse.fromJson(Map<String, dynamic> json) =>
      SendMailResponse(
        messageId: json['messageId'] as String,
        provider: json['provider'] as String,
        acceptedAt: json['acceptedAt'] as String,
      );
}

/// A local, client-only draft (there is no server draft store in the P0
/// contract). Held in memory by `draftsProvider` and rendered in the 下書き
/// folder. Optimistic UI: saving a draft updates the list instantly.
class MailDraft {
  const MailDraft({
    required this.id,
    required this.to,
    required this.subject,
    required this.body,
    required this.savedAt,
  });

  final String id;

  /// Raw "to" line as typed (comma/space separated), kept verbatim for editing.
  final String to;
  final String subject;
  final String body;

  /// ISO8601 UTC of the last save.
  final String savedAt;

  bool get isEmpty =>
      to.trim().isEmpty && subject.trim().isEmpty && body.trim().isEmpty;

  MailDraft copyWith({
    String? to,
    String? subject,
    String? body,
    String? savedAt,
  }) =>
      MailDraft(
        id: id,
        to: to ?? this.to,
        subject: subject ?? this.subject,
        body: body ?? this.body,
        savedAt: savedAt ?? this.savedAt,
      );

  /// Parses the free-text "to" line into modelled recipients for an outbox
  /// send. Splits on commas/whitespace; entries without "@" are dropped.
  List<MailAddress> get recipients => to
      .split(RegExp(r'[,\s]+'))
      .map((s) => s.trim())
      .where((s) => s.contains('@'))
      .map((s) => MailAddress(email: s))
      .toList();

  /// The outbox payload this draft would send (unused by the slice UI, which
  /// stops at "save draft"; kept so wiring a real send is a one-line change).
  SendMailRequest toSendRequest() => SendMailRequest(
        to: recipients,
        subject: subject,
        textBody: body,
      );
}
