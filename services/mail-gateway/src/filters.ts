// List filters (#899): unread / from / to / starred / has-attachment / date range / mailbox on
// GET /mail/messages and GET /mail/sent. Each is a WHERE fragment ANDed onto the caller's
// scope, so it can only narrow what the caller already sees. Every probe goes through an
// existing index — mail_attachments(message_kind, message_id), the delivery
// (inbound_id, envelope_to) unique index, the mail_user_flags primary key, and on Sent the
// (owner_user_id, status, created_at, id) index for the date bounds (sentFilter) — so a filter adds at
// most one index lookup per row the scope already reads (see test/filters.test.ts).
import type { mail } from "@dub/types";
import { LIST_ENVELOPE_PREFIX } from "./repo";

export interface Sql {
  sql: string;
  binds: unknown[];
}

const and = (parts: Sql[]): Sql | null =>
  parts.length === 0 ? null : { sql: parts.map((p) => p.sql).join(" AND "), binds: parts.flatMap((p) => p.binds) };

const safe = (col: string, empty: string): string => `CASE WHEN json_valid(${col}) THEN ${col} ELSE '${empty}' END`;

/** One address list column (JSON MailAddress[]) contains `?` (lower-cased exact match). */
const listHas = (col: string): string =>
  `EXISTS (SELECT 1 FROM json_each(${safe(col, "[]")}) je WHERE lower(trim(json_extract(je.value, '$.email'))) = ?)`;

/** A real file: inline images (a Content-ID on an image part) are part of the HTML body. */
const fileAttachment = (kind: "inbound" | "sent", idCol: string): string =>
  `EXISTS (SELECT 1 FROM mail_attachments ma WHERE ma.message_kind = '${kind}' AND ma.message_id = ${idCol}` +
  ` AND (ma.content_id IS NULL OR ma.mime_type NOT LIKE 'image/%'))`;

/** Message-level filters on mail_inbound (everything but unread / starred, which a folder
 *  view applies per conversation). Used in the folder view's per-thread aggregate and in the
 *  page fetch, exactly like the free-text search. */
export function inboundMessageFilter(f: mail.MailListFilters): Sql | null {
  const parts: Sql[] = [];
  if (f.from !== undefined)
    parts.push({ sql: `lower(trim(json_extract(${safe("mail_inbound.from_json", "{}")}, '$.email'))) = ?`, binds: [f.from] });
  if (f.to !== undefined)
    parts.push({ sql: `(${listHas("mail_inbound.to_json")} OR ${listHas("mail_inbound.cc_json")})`, binds: [f.to, f.to] });
  if (f.hasAttachment) parts.push({ sql: fileAttachment("inbound", "mail_inbound.id"), binds: [] });
  if (f.after !== undefined) parts.push({ sql: "mail_inbound.received_at >= ?", binds: [f.after] });
  if (f.before !== undefined) parts.push({ sql: "mail_inbound.received_at < ?", binds: [f.before] });
  if (f.mailbox !== undefined)
    parts.push({
      sql: "EXISTS (SELECT 1 FROM mail_inbound_delivery md WHERE md.inbound_id = mail_inbound.id AND md.envelope_to IN (?, ?))",
      binds: [f.mailbox, `${LIST_ENVELOPE_PREFIX}${f.mailbox}`],
    });
  return and(parts);
}

/** The viewer's own read state of one message (mirrors rowToListItem's `read`). */
export function inboundUnreadSql(viewer: string): Sql {
  const own = "EXISTS (SELECT 1 FROM mail_inbound_delivery vd WHERE vd.inbound_id = mail_inbound.id AND vd.owner_user_id = ?)";
  const ownRead = "EXISTS (SELECT 1 FROM mail_inbound_delivery vr WHERE vr.inbound_id = mail_inbound.id AND vr.owner_user_id = ? AND vr.read_at IS NOT NULL)";
  return {
    sql: `((${own} AND NOT ${ownRead}) OR (NOT ${own} AND mail_inbound.read_at IS NULL))`,
    binds: [viewer, viewer, viewer],
  };
}

/** Starred by the viewer: a primary-key lookup on mail_user_flags. */
const starredBy = (threadCols: string): string =>
  `EXISTS (SELECT 1 FROM mail_user_flags sf WHERE sf.owner_user_id = ? AND sf.thread_id IN (${threadCols}) AND sf.starred = 1 AND COALESCE(sf.purged, 0) = 0)`;

/** Legacy message-level list (no folder): every filter applies per message. */
export function inboundLegacyFilter(f: mail.MailListFilters, viewer: string): Sql | null {
  const parts: Sql[] = [];
  const msg = inboundMessageFilter(f);
  if (msg) parts.push(msg);
  if (f.unread !== undefined) {
    const u = inboundUnreadSql(viewer);
    parts.push({ sql: f.unread ? u.sql : `NOT ${u.sql}`, binds: u.binds });
  }
  if (f.starred) parts.push({ sql: starredBy("mail_inbound.thread_id"), binds: [viewer] });
  return and(parts);
}

/** Folder-view filters over the conversation (`t` = thread attrs, `uf` = viewer flags). */
export function threadFilterSql(f: mail.MailListFilters): string {
  const parts: string[] = [];
  if (f.unread !== undefined) parts.push(f.unread ? "t.unread_n = 1" : "t.unread_n = 0");
  if (f.starred) parts.push("COALESCE(uf.starred, 0) = 1");
  return parts.map((p) => ` AND ${p}`).join("");
}

/** Filters on mail_send_log (GET /sent). A send is never unread, so unread=1 matches nothing.
 *  Starred is looked up under every key the conversation can carry: the reply's thread id,
 *  the send-log id (a lone send), and its RFC Message-Id (a send that opened a thread). */
export function sentFilter(f: mail.MailListFilters, viewer: string | undefined): Sql | null {
  const parts: Sql[] = [];
  if (f.unread === true) parts.push({ sql: "1 = 0", binds: [] });
  const from = f.from ?? f.mailbox;
  if (f.from !== undefined && f.mailbox !== undefined && f.from !== f.mailbox) parts.push({ sql: "1 = 0", binds: [] });
  else if (from !== undefined) parts.push({ sql: "lower(mail_send_log.from_address) = ?", binds: [from] });
  if (f.to !== undefined)
    parts.push({ sql: `(${listHas("mail_send_log.to_json")} OR ${listHas("mail_send_log.cc_json")})`, binds: [f.to, f.to] });
  if (f.hasAttachment) parts.push({ sql: fileAttachment("sent", "mail_send_log.id"), binds: [] });
  if (f.after !== undefined) parts.push({ sql: "mail_send_log.created_at >= ?", binds: [f.after] });
  // With both bounds the planner rates a two-sided range above the owner equality and walks
  // every user's sends on (status, created_at); the unary + keeps (owner, status, created_at).
  if (f.before !== undefined)
    parts.push({ sql: `${f.after !== undefined ? "+" : ""}mail_send_log.created_at < ?`, binds: [f.before] });
  if (f.starred) {
    const rfc = "mail_send_log.id || '@' || substr(mail_send_log.from_address, instr(mail_send_log.from_address, '@') + 1)";
    parts.push({ sql: starredBy(`mail_send_log.thread_id, mail_send_log.id, ${rfc}`), binds: [viewer ?? ""] });
  }
  return and(parts);
}

/** True when any filter is set (a filtered page skips nothing else). */
export function hasFilters(f: mail.MailListFilters | undefined): f is mail.MailListFilters {
  return f !== undefined && Object.values(f).some((v) => v !== undefined);
}
