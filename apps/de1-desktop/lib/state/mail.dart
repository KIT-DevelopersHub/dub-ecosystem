import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/mail_api.dart';
import '../api/mail_models.dart';
import 'auth.dart';

/// The mail feature's client, bound to the shared gateway session.
final mailApiProvider = FutureProvider<MailApi>((ref) async {
  final client = await ref.watch(gatewayClientProvider.future);
  return MailApi(client);
});

/// Gmail-style folders. Only 受信トレイ has a live server listing; 下書き is a
/// local, client-only store (there is no server draft/folder model in the P0
/// mail contract).
enum MailFolder {
  inbox('受信トレイ', Icons.inbox_outlined),
  drafts('下書き', Icons.drafts_outlined);

  const MailFolder(this.label, this.icon);
  final String label;
  final IconData icon;
}

/// The folder currently shown in the message list.
final selectedFolderProvider =
    StateProvider<MailFolder>((_) => MailFolder.inbox);

/// First page of the inbox (`GET /api/v1/mail/messages`). Auto-refetches
/// whenever the gateway client is (re)created.
final mailMessagesProvider = FutureProvider<PaginatedMailMessages>((ref) async {
  final api = await ref.watch(mailApiProvider.future);
  return api.listMessages(limit: 50);
});

/// A thread's conversation for the reading pane
/// (`GET /api/v1/mail/threads/{id}`), keyed by thread id.
final mailThreadProvider =
    FutureProvider.family<MailThread, String>((ref, threadId) async {
  final api = await ref.watch(mailApiProvider.future);
  return api.getThread(threadId);
});

/// The message selected in the list (drives the reading pane). null = none.
final selectedMailProvider = StateProvider<MailMessage?>((_) => null);

/// The draft selected/being edited in the compose pane. null = none.
final selectedDraftProvider = StateProvider<MailDraft?>((_) => null);

/// Client-side read state.
///
/// The P0 mail contract has no server read-state, so "既読" is tracked locally
/// as the set of read message ids. Marking read is inherently instant
/// (optimistic UI): the set updates and the list re-renders immediately. If a
/// real `PATCH .../read` endpoint lands, [markRead] becomes the optimistic
/// update with a rollback-on-failure around the network call.
class ReadMailNotifier extends StateNotifier<Set<String>> {
  ReadMailNotifier() : super(const {});

  bool isRead(String id) => state.contains(id);

  void markRead(String id) {
    if (state.contains(id)) return;
    state = {...state, id};
  }

  void markUnread(String id) {
    if (!state.contains(id)) return;
    state = {...state}..remove(id);
  }
}

final readMailProvider =
    StateNotifierProvider<ReadMailNotifier, Set<String>>((_) {
  return ReadMailNotifier();
});

/// Local drafts store (there is no server draft store in P0). Optimistic UI:
/// saving/deleting updates the list instantly. Newest first.
class DraftsNotifier extends StateNotifier<List<MailDraft>> {
  DraftsNotifier() : super(const []);

  /// Inserts a new draft (returns it) — newest first.
  MailDraft create({
    required String to,
    required String subject,
    required String body,
  }) {
    final draft = MailDraft(
      id: 'draft_${DateTime.now().microsecondsSinceEpoch}',
      to: to,
      subject: subject,
      body: body,
      savedAt: DateTime.now().toUtc().toIso8601String(),
    );
    state = [draft, ...state];
    return draft;
  }

  /// Upserts an existing draft in place (keeps position), touching savedAt.
  void update(MailDraft draft) {
    final touched = draft.copyWith(
      savedAt: DateTime.now().toUtc().toIso8601String(),
    );
    final idx = state.indexWhere((d) => d.id == touched.id);
    if (idx < 0) {
      state = [touched, ...state];
      return;
    }
    final next = [...state];
    next[idx] = touched;
    state = next;
  }

  void delete(String id) {
    state = state.where((d) => d.id != id).toList();
  }
}

final draftsProvider =
    StateNotifierProvider<DraftsNotifier, List<MailDraft>>((_) {
  return DraftsNotifier();
});
