// Unit tests for the mail feature: wire-contract parsing, draft parsing, and
// the client-side read/draft state notifiers. No network.
import 'package:dub_desktop/api/mail_models.dart';
import 'package:dub_desktop/state/mail.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('mail wire contract', () {
    test('MailMessage parses from/to/snippet/receivedAt', () {
      final m = MailMessage.fromJson({
        'id': 'mmsg_1',
        'messageId': '<a1@developershub.jp>',
        'threadId': 'mthr_1',
        'from': {'email': 'sato@example.com', 'name': '佐藤 花子'},
        'to': [
          {'email': 'info@developershub.jp', 'name': 'DevHub 受付'}
        ],
        'subject': '協賛について',
        'snippet': '協賛プランの詳細をください。',
        'receivedAt': '2026-08-19T00:00:00.000Z',
      });
      expect(m.threadId, 'mthr_1');
      expect(m.from.shortLabel, '佐藤 花子');
      expect(m.to.single.email, 'info@developershub.jp');
      expect(m.subject, '協賛について');
    });

    test('MailAddress.display and shortLabel handle a missing name', () {
      const named = MailAddress(email: 'a@b.com', name: 'Alice');
      const bare = MailAddress(email: 'ops@developershub.jp');
      expect(named.display, 'Alice <a@b.com>');
      expect(named.shortLabel, 'Alice');
      expect(bare.display, 'ops@developershub.jp');
      expect(bare.shortLabel, 'ops');
    });

    test('PaginatedMailMessages parses items + nextCursor', () {
      final page = PaginatedMailMessages.fromJson({
        'items': [
          {
            'id': 'm1',
            'messageId': '<x>',
            'threadId': 't1',
            'from': {'email': 'a@b.com'},
            'to': [
              {'email': 'c@d.com'}
            ],
            'subject': 's',
            'snippet': 'snip',
            'receivedAt': '2026-08-19T00:00:00.000Z',
          }
        ],
        'nextCursor': null,
      });
      expect(page.items.length, 1);
      expect(page.nextCursor, isNull);
    });

    test('MailThread parses its messages', () {
      final t = MailThread.fromJson({
        'id': 't1',
        'messages': [
          {
            'id': 'm1',
            'messageId': '<x>',
            'threadId': 't1',
            'from': {'email': 'a@b.com'},
            'to': <dynamic>[],
            'subject': 's',
            'snippet': 'snip',
            'receivedAt': '2026-08-19T00:00:00.000Z',
          }
        ],
      });
      expect(t.id, 't1');
      expect(t.messages.single.id, 'm1');
    });

    test('SendMailRequest serialises to the outbox shape', () {
      const req = SendMailRequest(
        to: [MailAddress(email: 'x@developershub.jp')],
        subject: 'hi',
        textBody: 'body',
      );
      final json = req.toJson();
      expect((json['to'] as List).length, 1);
      expect(json['subject'], 'hi');
      expect(json['textBody'], 'body');
      // cc omitted when empty.
      expect(json.containsKey('cc'), isFalse);
    });
  });

  group('MailDraft', () {
    test('parses the free-text to line into recipients, dropping non-emails',
        () {
      const d = MailDraft(
        id: 'd1',
        to: 'a@x.com, not-an-email  b@y.com',
        subject: 's',
        body: 'b',
        savedAt: '2026-08-19T00:00:00.000Z',
      );
      final emails = d.recipients.map((r) => r.email).toList();
      expect(emails, ['a@x.com', 'b@y.com']);
      // toSendRequest carries them through.
      expect(d.toSendRequest().to.length, 2);
    });

    test('isEmpty is true only when every field is blank', () {
      const empty = MailDraft(
          id: 'd', to: '  ', subject: '', body: '\n', savedAt: 't');
      const nonEmpty =
          MailDraft(id: 'd', to: '', subject: 'x', body: '', savedAt: 't');
      expect(empty.isEmpty, isTrue);
      expect(nonEmpty.isEmpty, isFalse);
    });
  });

  group('ReadMailNotifier (optimistic read state)', () {
    test('markRead is instant and idempotent; markUnread reverts', () {
      final n = ReadMailNotifier();
      expect(n.isRead('m1'), isFalse);
      n.markRead('m1');
      expect(n.isRead('m1'), isTrue);
      final before = n.state;
      n.markRead('m1'); // idempotent: no new state object needed
      expect(identical(n.state, before), isTrue);
      n.markUnread('m1');
      expect(n.isRead('m1'), isFalse);
    });
  });

  group('DraftsNotifier (optimistic local drafts)', () {
    test('create inserts newest-first and update edits in place', () {
      final n = DraftsNotifier();
      final first = n.create(to: 'a@x.com', subject: 's1', body: 'b1');
      final second = n.create(to: 'b@x.com', subject: 's2', body: 'b2');
      expect(n.state.first.id, second.id); // newest first
      expect(n.state.length, 2);

      n.update(first.copyWith(subject: 's1-edited'));
      final edited = n.state.firstWhere((d) => d.id == first.id);
      expect(edited.subject, 's1-edited');
      expect(n.state.length, 2); // in place, no duplicate

      n.delete(second.id);
      expect(n.state.length, 1);
      expect(n.state.single.id, first.id);
    });
  });
}
