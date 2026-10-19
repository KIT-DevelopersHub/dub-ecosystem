// Pure helpers for the message menu: forward body, permalink, and the read marker
// that makes a message (and everything after it) unread again.
import type { common } from "@dub/types";
import type { Message } from "../api/contract";

/** Sorts below every message id, so "unread from the very first message" is expressible. */
export const BEFORE_FIRST_MESSAGE_ID = "0" as common.MessageId;

/**
 * Forwarded post: optional comment, then the original quoted line by line with its
 * author and source channel. `text` must already have mentions flattened to names
 * (toPlainMentions): a forwarded <@id> / <!team:id> would notify those people again.
 */
export function buildForwardBody({
  comment,
  text,
  authorName,
  sourceChannelName,
}: {
  comment: string;
  text: string;
  authorName: string;
  sourceChannelName: string;
}): string {
  const author = authorName;
  const quoted = (text.trim() || "(添付ファイル)")
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  const head = comment.trim();
  return `${head ? `${head}\n\n` : ""}${quoted}\n> — ${author} ${sourceChannelName} から転送`;
}

/** lastReadMessageId that leaves `messageId` as the first unread top-level message. */
export function unreadMarkerFor(messages: Pick<Message, "id">[], messageId: common.MessageId): common.MessageId {
  const idx = messages.findIndex((m) => m.id === messageId);
  return idx > 0 ? messages[idx - 1]!.id : BEFORE_FIRST_MESSAGE_ID;
}

/** Deep link to a message: /…/chat/channels/<id>?message=<id> on the current origin. */
export function messagePermalink(
  location: { origin: string; pathname: string },
  channelId: common.ChannelId,
  messageId: common.MessageId,
): string {
  const i = location.pathname.indexOf("/chat");
  const base = i >= 0 ? location.pathname.slice(0, i) : "";
  return `${location.origin}${base}/chat/channels/${channelId}?message=${messageId}`;
}

/** Count of unread top-level messages after `marker` that the viewer didn't write. */
export function countUnreadAfter(
  messages: Pick<Message, "id" | "authorId">[],
  marker: common.MessageId,
  currentUserId: common.UserId,
): number {
  return messages.filter((m) => m.id > marker && m.authorId !== currentUserId).length;
}
