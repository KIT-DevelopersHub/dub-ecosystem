// Pure helpers for the message menu: forward body, permalink, and the read marker
// that makes a message (and everything after it) unread again.
import type { common } from "@dub/types";
import type { Message } from "../api/contract";

/** Sorts below every message id, so "unread from the very first message" is expressible. */
export const BEFORE_FIRST_MESSAGE_ID = "0" as common.MessageId;

/**
 * Forwarded post: optional comment, then the original quoted line by line with its
 * author and source channel (and a permalink, so the card can jump to it). `text` must
 * already have mentions flattened to names (toPlainMentions): a forwarded <@id> /
 * <!team:id> would notify those people again. Stays readable as plain markdown.
 */
export function buildForwardBody({
  comment,
  text,
  authorName,
  sourceChannelName,
  link,
}: {
  comment: string;
  text: string;
  authorName: string;
  sourceChannelName: string;
  link?: string;
}): string {
  const quoted = (text.trim() || "(添付ファイル)")
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  const head = comment.trim();
  return `${head ? `${head}\n\n` : ""}${quoted}\n> — ${authorName}${FORWARD_SEP}${sourceChannelName} から転送${link ? ` ${link}` : ""}`;
}

const FORWARD_SEP = " · ";
const FORWARD_TAIL_RE = /^> — (.+) から転送(?: (https?:\/\/\S+))?$/;

export interface ParsedForward {
  comment: string;
  text: string;
  authorName: string;
  sourceChannelName: string;
  link: string | null;
}

/** Inverse of buildForwardBody (also reads the older "author #channel" tail). */
export function parseForwardBody(body: string): ParsedForward | null {
  const lines = body.split("\n");
  const tail = FORWARD_TAIL_RE.exec(lines[lines.length - 1] ?? "");
  if (!tail) return null;
  let start = lines.length - 1;
  while (start > 0 && lines[start - 1]!.startsWith(">")) start--;
  if (start === lines.length - 1) return null; // a tail with no quoted text is not ours
  const who = tail[1]!;
  const sep = who.lastIndexOf(FORWARD_SEP);
  const space = who.lastIndexOf(" ");
  const cut = sep >= 0 ? [sep, sep + FORWARD_SEP.length] : space > 0 ? [space, space + 1] : null;
  if (!cut) return null;
  return {
    comment: lines.slice(0, start).join("\n").trim(),
    text: lines
      .slice(start, -1)
      .map((l) => l.replace(/^> ?/, ""))
      .join("\n"),
    authorName: who.slice(0, cut[0]),
    sourceChannelName: who.slice(cut[1]),
    link: tail[2] ?? null,
  };
}

/** lastReadMessageId that leaves `messageId` as the first unread top-level message. */
export function unreadMarkerFor(messages: Pick<Message, "id">[], messageId: common.MessageId): common.MessageId {
  const idx = messages.findIndex((m) => m.id === messageId);
  return idx > 0 ? messages[idx - 1]!.id : BEFORE_FIRST_MESSAGE_ID;
}

/**
 * Deep link to a message: /…/chat/channels/<id>?message=<id> on the current origin.
 * Thread replies carry &thread=<root> (they are not in the channel timeline).
 */
export function messagePermalink(
  location: { origin: string; pathname: string },
  channelId: common.ChannelId,
  messageId: common.MessageId,
  threadRootId?: common.MessageId | null,
): string {
  const i = location.pathname.indexOf("/chat");
  const base = i >= 0 ? location.pathname.slice(0, i) : "";
  const thread = threadRootId ? `&thread=${encodeURIComponent(threadRootId)}` : "";
  return `${location.origin}${base}/chat/channels/${encodeURIComponent(channelId)}?message=${encodeURIComponent(messageId)}${thread}`;
}

/** Origins whose message links unfurl as a quote card (besides the current one). */
export const KNOWN_CHAT_ORIGINS = ["https://app.developershub.jp"];

export interface MessageLink {
  channelId: common.ChannelId;
  messageId: common.MessageId;
  threadRootId: common.MessageId | null;
}

/** A 「リンクをコピー」 URL of this app (current or known origin), else null. */
export function parseMessageLink(href: string, currentOrigin: string | undefined): MessageLink | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.origin !== currentOrigin && !KNOWN_CHAT_ORIGINS.includes(url.origin)) return null;
  const m = /\/chat\/channels\/([^/]+)\/?$/.exec(url.pathname);
  const messageId = url.searchParams.get("message");
  if (!m || !messageId) return null;
  return {
    channelId: decodeURIComponent(m[1]!) as common.ChannelId,
    messageId: messageId as common.MessageId,
    threadRootId: (url.searchParams.get("thread") || null) as common.MessageId | null,
  };
}

/** Count of unread top-level messages after `marker` that the viewer didn't write. */
export function countUnreadAfter(
  messages: Pick<Message, "id" | "authorId">[],
  marker: common.MessageId,
  currentUserId: common.UserId,
): number {
  return messages.filter((m) => m.id > marker && m.authorId !== currentUserId).length;
}
