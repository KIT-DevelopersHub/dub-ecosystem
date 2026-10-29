// D1 access for the mail_ namespace. Uses @dub/db DbClient (namespace-scoped,
// runtime-DDL-forbidden). Every SQL statement touches mail_* tables only.
import { type DbClient, newId, nowIso } from "@dub/db";
import { errors } from "@dub/errors";
import type { common, mail } from "@dub/types";

// ---- row shapes ----
export interface SendLogRow {
  id: string;
  idempotency_key: string;
  req_hash: string;
  requester: string;
  to_json: string;
  subject: string;
  thread_id: string | null;
  provider: string | null;
  provider_message_id: string | null;
  status: "pending" | "sent" | "failed";
  error_code: string | null;
  created_at: string;
  updated_at: string;
  text_body: string | null; // 0004: plain-text body as submitted (Sent detail)
  html_body: string | null; // 0004: HTML part when present (sanitized before render)
  cc_json: string | null; // 0004: JSON MailAddress[] of Cc recipients
  snippet: string | null; // 0004: first ~140 chars of text_body (Sent list preview)
  from_address: string | null; // 0004: envelope From used for the send
  owner_user_id: string | null; // 0006: the user who sent it (Sent-folder scope); NULL = system
  bcc_json?: string | null; // 0018: JSON MailAddress[] of Bcc recipients (sender-only); NULL = none / pre-0018
}

export interface InboundRow {
  id: string;
  message_id: string;
  thread_id: string;
  mailbox: string | null;
  from_json: string;
  to_json: string;
  subject: string;
  snippet: string;
  auto_submitted: string | null;
  loop_marker: string | null;
  received_at: string;
  created_at: string;
  body_text: string | null; // 0002: full plain-text body (detail view)
  html_body: string | null; // 0002: HTML part when present (sanitized before render)
  read_at: string | null; // 0002: ISO8601 when first opened; NULL = unread
  owner_user_id: string | null; // 0006: roster user the message was delivered to (Inbox scope); NULL = unassigned
  cc_json: string | null; // 0012: JSON MailAddress[] of Cc header recipients; NULL = none / pre-0012
  header_meta_json?: string | null; // 0013: JSON MailHeaderMeta; NULL = nothing known / pre-0013
  raw_r2_key?: string | null; // 0014: R2 key of the untruncated raw .eml; NULL = not archived / pre-0014
  deleted_at?: string | null; // 0016: soft-delete stamp (destructive.ts); NULL = live
  // Viewer projection (0018, computed per query from mail_inbound_delivery, not stored):
  viewer_deliveries?: number | null; // how many deliveries of this message belong to the viewer
  viewer_read_at?: string | null; // the viewer's own read stamp (any of their deliveries)
  viewer_envelope?: string | null; // the envelope address the viewer's copy was delivered to
}

export interface MailboxRow {
  id: string;
  address: string;
  provider: string;
  created_at: string;
  updated_at: string;
}

export interface AttachmentRow {
  id: string;
  message_kind: "sent" | "inbound";
  message_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  r2_key: string;
  created_at: string;
  status: "stored" | "dropped_too_large" | "dropped_truncated"; // 0007: 'stored' default
}

// ---- opaque cursor codec (base64url of the row id; D3) ----
export function encodeCursor(id: string): string {
  return btoa(id).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function decodeCursor(cursor: string): string {
  try {
    return atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    throw errors.validationFailed([{ field: "cursor", reason: "invalid_cursor" }]);
  }
}

// ---- outbound send log ----
export async function findSendByKey(db: DbClient, idempotencyKey: string): Promise<SendLogRow | null> {
  return db.first<SendLogRow>(`SELECT * FROM mail_send_log WHERE idempotency_key = ?`, idempotencyKey);
}

/** First ~140 chars of the body on a single line — the Sent-list preview text. */
export function snippetOf(textBody: string, max = 140): string {
  const oneLine = textBody.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) : oneLine;
}

/** Claim a send: INSERT OR IGNORE on the UNIQUE idempotency_key. changes===0 means a
 *  concurrent/prior claim won the race (the caller then re-reads and dedups). The body
 *  columns (text/html/cc/snippet/from — migration 0004) are persisted at claim time so
 *  a later status='sent' row can back the Sent folder. The idempotency contract is
 *  unchanged: still one INSERT OR IGNORE on UNIQUE(idempotency_key), added columns only. */
export async function insertSendClaim(
  db: DbClient,
  row: {
    id: string;
    idempotencyKey: string;
    reqHash: string;
    requester: string;
    toJson: string;
    subject: string;
    threadId: string | null;
    textBody: string;
    htmlBody: string | null;
    ccJson: string;
    // Bcc recipients (JSON MailAddress[]) or null when none. Shown in Sent to the sender only.
    bccJson?: string | null;
    fromAddress: string;
    // Owner = the human sender (Sent-folder scope). NULL for pure system/automation
    // sends with no user on the call — they belong to no person's Sent folder.
    ownerUserId: string | null;
  },
): Promise<number> {
  const now = nowIso();
  const res = await db.run(
    `INSERT OR IGNORE INTO mail_send_log
       (id, idempotency_key, req_hash, requester, to_json, subject, thread_id,
        provider, provider_message_id, status, error_code, created_at, updated_at,
        text_body, html_body, cc_json, snippet, from_address, owner_user_id, bcc_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'pending', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.idempotencyKey,
    row.reqHash,
    row.requester,
    row.toJson,
    row.subject,
    row.threadId,
    now,
    now,
    row.textBody,
    row.htmlBody,
    row.ccJson,
    snippetOf(row.textBody),
    row.fromAddress,
    row.ownerUserId,
    row.bccJson ?? null,
  );
  return res.meta.changes;
}

export async function markSendSent(db: DbClient, id: string, provider: string, providerMessageId: string): Promise<void> {
  await db.run(
    `UPDATE mail_send_log SET status = 'sent', provider = ?, provider_message_id = ?, error_code = NULL, updated_at = ?
     WHERE id = ?`,
    provider,
    providerMessageId,
    nowIso(),
    id,
  );
}

/** Most recent FAILED send (error_code + updated_at only) — backs the rate-limit status
 *  view. Uses idx_mail_send_log_status(status, updated_at) for an index-ordered read. */
export async function latestFailedSend(db: DbClient): Promise<{ error_code: string | null; updated_at: string } | null> {
  return db.first<{ error_code: string | null; updated_at: string }>(
    `SELECT error_code, updated_at FROM mail_send_log WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 1`,
  );
}

export async function markSendFailed(db: DbClient, id: string, errorCode: string): Promise<void> {
  await db.run(
    `UPDATE mail_send_log SET status = 'failed', error_code = ?, updated_at = ? WHERE id = ?`,
    errorCode,
    nowIso(),
    id,
  );
}

// ---- sent folder (projects status='sent' send-log rows into read DTOs) ----
function parseAddresses(json: string | null): mail.MailAddress[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as mail.MailAddress[]) : [];
  } catch {
    return [];
  }
}

function sendRowToListItem(r: SendLogRow, viewer?: string): mail.MailSentListItem {
  const item: mail.MailSentListItem = {
    id: r.id,
    to: parseAddresses(r.to_json),
    subject: r.subject,
    snippet: r.snippet ?? "",
    sentAt: r.updated_at, // when the row flipped to 'sent'
    provider: (r.provider as mail.SendMailResponse["provider"]) ?? "ses",
    status: "sent",
  };
  const cc = parseAddresses(r.cc_json);
  if (cc.length > 0) item.cc = cc;
  if (r.from_address) item.from = { email: r.from_address };
  // Bcc is the sender's private knowledge: only the owner sees it (never read_all oversight).
  if (viewer !== undefined && r.owner_user_id !== null && r.owner_user_id === viewer) {
    const bcc = parseAddresses(r.bcc_json ?? null);
    if (bcc.length > 0) item.bcc = bcc;
  }
  if (r.provider_message_id) item.providerMessageId = r.provider_message_id;
  // thread_id is set for replies (= the parent message's id). Surfacing it lets the
  // client fold a sent reply back into its conversation instead of showing it as a
  // detached Sent thread (so the reply stays visible in the open thread).
  if (r.thread_id) item.threadId = r.thread_id;
  return item;
}

function sendRowToDetail(r: SendLogRow, viewer?: string): mail.MailSentDetail {
  const detail: mail.MailSentDetail = { ...sendRowToListItem(r, viewer), textBody: r.text_body ?? "" };
  if (r.html_body !== null && r.html_body !== "") detail.htmlBody = r.html_body;
  return detail;
}

function parseHeaderMeta(json: string | null | undefined): mail.MailHeaderMeta | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" ? (v as mail.MailHeaderMeta) : null;
  } catch {
    return null;
  }
}

/** Read scope for the account-isolated mail queries. A plain userId string scopes a
 *  query to that owner's own mail (the #169 per-account isolation, fail-closed). The
 *  `{ readAll: true }` variant is the `mail:read_all` OVERSIGHT bypass: an authorized
 *  supervisor / info@ / admin@ account sees EVERY row (owner filter dropped, including
 *  NULL-owner archive/system rows). Callers resolve which variant to pass from the
 *  caller's permissions — the repo never decides policy, only applies the given scope. */
export type MailScope = string | { readAll: true };

/** True when the scope is the mail:read_all oversight bypass (no owner filter). */
function isReadAll(scope: MailScope): scope is { readAll: true } {
  return typeof scope === "object";
}

/** Read scope for INBOUND mail only. Adds the shared variant: the caller plus the users whose
 *  inbound mail they may read — same-role sharing (`mail:read_role_shared`) and cross-role
 *  visibility (`{ userIds }`, resolved by the route via identity-roster). Kept a
 *  separate type so Sent / Scheduled can never be handed a shared scope. `viewer` is the
 *  caller — it only drives the `mine` flag on the returned items, never the filter. */
export type InboundScope = MailScope | { userIds: string[] };

/** Visibility predicate for an inbound scope, or null for the read_all bypass. A message is
 *  in scope when one of its deliveries (0018: one per envelope recipient, so To + Cc + Bcc
 *  colleagues each get their own) belongs to a scoped owner. The legacy single
 *  `mail_inbound.owner_user_id` is still honoured so a row ingested before the backfill (or
 *  by an older Worker during rollout) never disappears. An empty owner list matches nothing
 *  (fail-closed). The owner list rides as ONE JSON bind: D1 caps bound parameters per
 *  statement at 100, and cross-role visibility can exceed that. */
function inboundOwnerClause(scope: InboundScope): { sql: string; binds: string[] } | null {
  if (typeof scope === "string") {
    return {
      sql: "(owner_user_id = ? OR id IN (SELECT inbound_id FROM mail_inbound_delivery WHERE owner_user_id = ?))",
      binds: [scope, scope],
    };
  }
  if ("readAll" in scope) return null;
  const ids = [...new Set(scope.userIds)];
  if (ids.length === 0) return { sql: "1 = 0", binds: [] };
  const json = JSON.stringify(ids);
  return {
    sql:
      "(owner_user_id IN (SELECT value FROM json_each(?))" +
      " OR id IN (SELECT inbound_id FROM mail_inbound_delivery WHERE owner_user_id IN (SELECT value FROM json_each(?))))",
    binds: [json, json],
  };
}

/** SELECT list for inbound reads: the message row plus the VIEWER's own delivery state
 *  (count / read stamp / envelope), so `read` and `mine` are per recipient. Binds the viewer
 *  three times ('' when unknown, which matches no delivery). */
function inboundSelect(viewer: string | undefined): { sql: string; binds: string[] } {
  const v = viewer ?? "";
  const sub = (expr: string) =>
    `(SELECT ${expr} FROM mail_inbound_delivery vd WHERE vd.inbound_id = mail_inbound.id AND vd.owner_user_id = ?)`;
  return {
    sql: `SELECT mail_inbound.*, ${sub("COUNT(*)")} AS viewer_deliveries, ${sub("MAX(vd.read_at)")} AS viewer_read_at, ${sub("MIN(vd.envelope_to)")} AS viewer_envelope FROM mail_inbound`,
    binds: [v, v, v],
  };
}

/** Escape LIKE wildcards so a user's `%` / `_` / `\\` match literally (paired with ESCAPE '\\'). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Free-text search predicate (Gmail-style substring match). SQLite LIKE is ASCII
 *  case-insensitive and matches UTF-8 substrings, so Japanese works as-is. Address
 *  columns are matched per element (name + email) via json_each, never on the raw JSON,
 *  so a needle like "email" does not hit every row's keys; malformed JSON reads as empty.
 *  ANDed onto the caller's scope clause — it can only narrow, never widen, visibility. */
function searchClause(q: string, text: string[], single: string[], lists: string[]): { sql: string; binds: string[] } {
  const pat = `%${escapeLike(q)}%`;
  const like = (expr: string) => `${expr} LIKE ? ESCAPE '\\'`;
  const safe = (col: string, empty: string) => `CASE WHEN json_valid(${col}) THEN ${col} ELSE '${empty}' END`;
  const parts: string[] = [];
  for (const c of text) parts.push(like(`COALESCE(${c}, '')`));
  for (const c of single) {
    parts.push(like(`COALESCE(json_extract(${safe(c, "{}")}, '$.name'), '')`));
    parts.push(like(`COALESCE(json_extract(${safe(c, "{}")}, '$.email'), '')`));
  }
  for (const c of lists) {
    parts.push(
      `EXISTS (SELECT 1 FROM json_each(${safe(c, "[]")}) je WHERE ${like("COALESCE(json_extract(je.value, '$.name'), '')")} OR ${like("COALESCE(json_extract(je.value, '$.email'), '')")})`,
    );
  }
  const binds = parts.flatMap((p) => Array<string>((p.match(/LIKE \?/g) ?? []).length).fill(pat));
  return { sql: `(${parts.join(" OR ")})`, binds };
}

/** List sent mail (status='sent'), newest first. id-based opaque cursor (like
 *  listInbound); ULID ids sort in creation order so the id cursor tracks created_at. */
export async function listSent(
  db: DbClient,
  q: { ownerUserId: MailScope; viewer?: string; cursor?: string; limit: number; q?: string },
): Promise<common.Paginated<mail.MailSentListItem>> {
  // Fail-closed account scope: only the signed-in user's own delivered sends. A NULL
  // owner_user_id (system send / legacy row) never matches `= ?`, so it is invisible.
  // Oversight (mail:read_all) drops the owner filter entirely and returns every send.
  const where: string[] = ["status = 'sent'"];
  const binds: unknown[] = [];
  if (!isReadAll(q.ownerUserId)) {
    where.push("owner_user_id = ?");
    binds.push(q.ownerUserId);
  }
  if (q.q !== undefined) {
    // Bcc is deliberately NOT searched: it is sender-only, and a read_all viewer must not
    // learn a hidden recipient by probing.
    const s = searchClause(q.q, ["subject", "snippet", "text_body"], [], ["to_json", "cc_json"]);
    where.push(s.sql);
    binds.push(...s.binds);
  }
  if (q.cursor !== undefined) {
    where.push("id < ?");
    binds.push(decodeCursor(q.cursor));
  }
  const rows = await db.all<SendLogRow>(
    `SELECT * FROM mail_send_log WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ...binds,
    q.limit + 1,
  );
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map((r) => sendRowToListItem(r, q.viewer)),
    nextCursor: hasMore && last ? encodeCursor(last.id) : null,
  };
}

/** Full sent detail (body included) — backs GET /sent/:id. Only a delivered
 *  (status='sent') row is returned; a pending/failed row reads as not-found. */
export async function getSentDetail(db: DbClient, id: string, scope: MailScope, viewer?: string): Promise<mail.MailSentDetail | null> {
  // Account scope: a user can only open their OWN sent mail — another user's id reads as
  // not-found (fail-closed 404), never a 403 that would confirm the row exists. Oversight
  // (mail:read_all) drops the owner filter so a supervisor can open any delivered send.
  const binds: unknown[] = [id];
  let sql = `SELECT * FROM mail_send_log WHERE id = ? AND status = 'sent'`;
  if (!isReadAll(scope)) {
    sql += ` AND owner_user_id = ?`;
    binds.push(scope);
  }
  const row = await db.first<SendLogRow>(sql, ...binds);
  return row ? sendRowToDetail(row, viewer) : null;
}

// ---- inbound ----
/** Record one envelope delivery of a stored message (0018). INSERT OR IGNORE on the
 *  (message, envelope, owner) unique index makes an Email Routing redelivery a no-op.
 *  ownerUserId NULL = an ownerless copy (archive@ oversight / non-roster address). */
export async function insertDelivery(
  db: DbClient,
  d: { inboundId: string; ownerUserId: string | null; envelopeTo: string },
): Promise<number> {
  const now = nowIso();
  const res = await db.run(
    `INSERT OR IGNORE INTO mail_inbound_delivery
       (id, inbound_id, owner_user_id, envelope_to, read_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    newDeliveryId(),
    d.inboundId,
    d.ownerUserId,
    d.envelopeTo.trim().toLowerCase(),
    now,
    now,
  );
  return res.meta.changes;
}

/** Fill the legacy single owner column when the first copy was ownerless (e.g. archive@
 *  arrived first). Keeps mail_inbound.owner_user_id meaningful for older readers. */
export async function claimInboundOwnerIfUnset(db: DbClient, inboundId: string, ownerUserId: string): Promise<void> {
  await db.run(`UPDATE mail_inbound SET owner_user_id = ? WHERE id = ? AND owner_user_id IS NULL`, ownerUserId, inboundId);
}

/** The envelope address `userId`'s own copy of a message was delivered to, if any. */
export async function findDeliveryEnvelope(db: DbClient, inboundId: string, userId: string): Promise<string | null> {
  const row = await db.first<{ envelope_to: string }>(
    `SELECT envelope_to FROM mail_inbound_delivery WHERE inbound_id = ? AND owner_user_id = ? AND envelope_to <> '' ORDER BY created_at ASC LIMIT 1`,
    inboundId,
    userId,
  );
  return row?.envelope_to ?? null;
}

/** The received message with this RFC Message-Id, if any. Backs reply-From resolution:
 *  a reply's inReplyTo points at the parent inbound message, whose recipient mailbox
 *  (the address the conversation was addressed to, e.g. info@) is the identity the reply
 *  should go out as. Returns the raw row so callers can read to_json / mailbox. */
export async function findInboundByMessageId(db: DbClient, messageId: string): Promise<InboundRow | null> {
  return db.first<InboundRow>(`SELECT * FROM mail_inbound WHERE message_id = ?`, messageId);
}

/** One send-log row by its internal id (= the local-part of our RFC Message-Id
 *  `<send-log id>@domain`). Backs thread normalization when a reply references one of
 *  OUR earlier sends rather than a received message. */
export async function findSendLogById(db: DbClient, id: string): Promise<SendLogRow | null> {
  return db.first<SendLogRow>(`SELECT * FROM mail_send_log WHERE id = ?`, id);
}

/**
 * Resolve the canonical (root) thread id for a message from the RFC Message-Ids it
 * references (References tokens + In-Reply-To, most-ancestral first). Walks each candidate
 * against known messages and adopts the FIRST match's thread:
 *   - a received message (mail_inbound.message_id) -> its thread_id
 *   - one of OUR sent messages (RFC id = "<send-log id>@domain") -> that send's thread_id,
 *     or the candidate itself when that send OPENED the conversation (thread_id NULL)
 * Returns null when no candidate is known, so the caller keeps its own fallback (a fresh
 * thread). This is the normalization that keeps a 3+ message conversation on ONE thread id
 * even when a client trims its References chain to just the immediate parent, or when we
 * reply to our own thread (改善#3 スレッドID正規化 / #4 送信返信の連結). Read-only: it never
 * mutates existing rows, so already-stored threads are untouched (後方互換).
 */
export async function resolveThreadId(db: DbClient, candidateIds: string[]): Promise<string | null> {
  const seen = new Set<string>();
  for (const raw of candidateIds) {
    const ref = raw.trim().replace(/^<|>$/g, "").trim();
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    const inbound = await findInboundByMessageId(db, ref);
    if (inbound) return inbound.thread_id;
    const localPart = ref.split("@")[0] ?? "";
    if (localPart.startsWith("maillog_")) {
      const sent = await findSendLogById(db, localPart);
      if (sent) return sent.thread_id ?? ref;
    }
  }
  return null;
}

/** Persist a normalized inbound message body. INSERT OR IGNORE on message_id: the 2nd
 *  envelope copy (another recipient) or a redelivery is a no-op here — per-recipient
 *  visibility lives in mail_inbound_delivery. Returns changes (0 = already stored). */
export async function insertInbound(
  db: DbClient,
  m: mail.MailMessage,
  extra: {
    mailbox: string | null;
    autoSubmitted: string | null;
    loopMarker: string | null;
    bodyText: string;
    htmlBody: string | null;
    cc?: mail.MailAddress[];
    headerMeta?: mail.MailHeaderMeta;
    // Owner = the roster user this message was delivered to (Inbox scope). NULL when no
    // roster user matches the recipient — invisible to every account until assignable.
    ownerUserId: string | null;
  },
): Promise<number> {
  const res = await db.run(
    `INSERT OR IGNORE INTO mail_inbound
       (id, message_id, thread_id, mailbox, from_json, to_json, subject, snippet,
        auto_submitted, loop_marker, received_at, created_at, body_text, html_body, read_at, owner_user_id, cc_json, header_meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    m.id,
    m.messageId,
    m.threadId,
    extra.mailbox,
    JSON.stringify(m.from),
    JSON.stringify(m.to),
    m.subject,
    m.snippet,
    extra.autoSubmitted,
    extra.loopMarker,
    m.receivedAt,
    nowIso(),
    extra.bodyText,
    extra.htmlBody,
    extra.ownerUserId,
    extra.cc && extra.cc.length > 0 ? JSON.stringify(extra.cc) : null,
    extra.headerMeta && Object.keys(extra.headerMeta).length > 0 ? JSON.stringify(extra.headerMeta) : null,
  );
  return res.meta.changes;
}

/** Record where the raw .eml of an inbound row was archived (raw-eml.ts). */
export async function setInboundRawKey(db: DbClient, inboundId: string, key: string): Promise<void> {
  await db.run(`UPDATE mail_inbound SET raw_r2_key = ? WHERE id = ?`, key, inboundId);
}

function rowToMailMessage(r: InboundRow): mail.MailMessage {
  return {
    id: r.id,
    messageId: r.message_id,
    threadId: r.thread_id,
    from: JSON.parse(r.from_json) as mail.MailAddress,
    to: JSON.parse(r.to_json) as mail.MailAddress[],
    subject: r.subject,
    snippet: r.snippet,
    receivedAt: r.received_at,
  };
}

/** List item = frozen message + read flag. `read` is the VIEWER's own state when they hold
 *  a delivery of it (per recipient, 0018); otherwise (read_all / role sharing / legacy row)
 *  it is the primary owner's mail_inbound.read_at as before. */
function rowToListItem(r: InboundRow, viewer?: string): mail.MailMessageListItem {
  const own = (r.viewer_deliveries ?? 0) > 0;
  const item: mail.MailMessageListItem = { ...rowToMailMessage(r), read: own ? r.viewer_read_at != null : r.read_at !== null };
  // mine: delivered to the caller (vs visible via read_all / role sharing). Only set when
  // the caller is known so internal callers keep the frozen shape.
  if (viewer !== undefined) item.mine = own || r.owner_user_id === viewer;
  const cc = parseAddresses(r.cc_json);
  if (cc.length > 0) item.cc = cc;
  return item;
}

/** Detail = list item + full body. htmlBody omitted (not set) when the row has none. */
function rowToDetail(r: InboundRow, viewer?: string): mail.MailMessageDetail {
  const detail: mail.MailMessageDetail = { ...rowToListItem(r, viewer), textBody: r.body_text ?? "" };
  if (r.html_body !== null && r.html_body !== "") detail.htmlBody = r.html_body;
  const meta = parseHeaderMeta(r.header_meta_json);
  // deliveredTo on the body row is whichever copy arrived first: show the viewer's own.
  if (r.viewer_envelope) detail.headerMeta = { ...(meta ?? {}), deliveredTo: r.viewer_envelope };
  else if (meta) detail.headerMeta = meta;
  return detail;
}

/** Frozen-message read (kept for callers that only need the base DTO). */
export async function getInboundById(db: DbClient, id: string): Promise<mail.MailMessage | null> {
  const row = await db.first<InboundRow>(`SELECT * FROM mail_inbound WHERE id = ?`, id);
  return row ? rowToMailMessage(row) : null;
}

/** Full detail (body + read state) — backs GET /messages/:id. Account-scoped: another
 *  user's message reads as not-found (fail-closed 404), never exposing its body. */
export async function getInboundDetail(db: DbClient, id: string, scope: InboundScope, viewer?: string): Promise<mail.MailMessageDetail | null> {
  // Oversight (mail:read_all) drops the owner filter so a supervisor sees any message body.
  const sel = inboundSelect(viewer);
  const binds: unknown[] = [...sel.binds, id];
  let sql = `${sel.sql} WHERE id = ?`;
  const owner = inboundOwnerClause(scope);
  if (owner) {
    sql += ` AND ${owner.sql}`;
    binds.push(...owner.binds);
  }
  const row = await db.first<InboundRow>(sql, ...binds);
  return row ? rowToDetail(row, viewer) : null;
}

/** Every message in a thread, oldest→newest, as full details — backs GET /threads/:id.
 *  Account-scoped: only messages in the caller's scope are returned (a thread with none
 *  reads as empty → 404 at the route). Inbound rows ONLY — sent rows are never joined in,
 *  so role sharing (an inbound-only scope) cannot surface a peer's outbound mail here. */
export async function listThread(db: DbClient, threadId: string, scope: InboundScope, viewer?: string): Promise<mail.MailMessageDetail[]> {
  // Oversight (mail:read_all) drops the owner filter so a supervisor sees the whole thread.
  const sel = inboundSelect(viewer);
  const binds: unknown[] = [...sel.binds, threadId];
  let sql = `${sel.sql} WHERE thread_id = ?`;
  const owner = inboundOwnerClause(scope);
  if (owner) {
    sql += ` AND ${owner.sql}`;
    binds.push(...owner.binds);
  }
  sql += ` ORDER BY received_at ASC, id ASC`;
  const rows = await db.all<InboundRow>(sql, ...binds);
  return rows.map((r) => rowToDetail(r, viewer));
}

/** Mark a message read (idempotent): stamps read_at only on the first open. Returns
 *  whether the message is visible in `scope` so the route can 404 an unknown/foreign id.
 *  Only `self`'s OWN deliveries are stamped (per recipient, 0018): a Cc'd colleague opening
 *  it leaves the To recipient's unread state alone, and read_all / role-sharing viewers
 *  stay view-only (#700). */
export async function markInboundRead(db: DbClient, id: string, scope: InboundScope, self: string): Promise<{ found: boolean }> {
  // Oversight (mail:read_all) and role sharing may OPEN another account's message, but
  // read_at is per message — flipping it would clear the owner's unread state.
  const owner = inboundOwnerClause(scope);
  const ownerSql = owner ? ` AND ${owner.sql}` : "";
  const ownerBinds = owner ? owner.binds : [];
  const row = await db.first<{ id: string }>(`SELECT id FROM mail_inbound WHERE id = ?${ownerSql}`, id, ...ownerBinds);
  if (!row) return { found: false };
  const now = nowIso();
  await db.run(
    `UPDATE mail_inbound_delivery SET read_at = ?, updated_at = ? WHERE inbound_id = ? AND owner_user_id = ? AND read_at IS NULL`,
    now,
    now,
    id,
    self,
  );
  // Legacy primary-owner stamp (what read_all / role-sharing viewers see as "read").
  await db.run(`UPDATE mail_inbound SET read_at = ? WHERE id = ? AND owner_user_id = ? AND read_at IS NULL`, now, id, self);
  return { found: true };
}

export async function listInbound(
  db: DbClient,
  q: { ownerUserId: InboundScope; viewer?: string; threadId?: string; cursor?: string; limit: number; q?: string },
): Promise<common.Paginated<mail.MailMessageListItem>> {
  // Fail-closed account scope: only messages delivered to the signed-in user (plus role-
  // sharing peers). A NULL owner_user_id (unassigned / legacy row) never matches, so it
  // stays invisible. Oversight (mail:read_all) drops the owner filter entirely.
  const where: string[] = [];
  const binds: unknown[] = [];
  const owner = inboundOwnerClause(q.ownerUserId);
  if (owner) {
    where.push(owner.sql);
    binds.push(...owner.binds);
  }
  if (q.threadId !== undefined) {
    where.push("thread_id = ?");
    binds.push(q.threadId);
  }
  if (q.q !== undefined) {
    const s = searchClause(q.q, ["subject", "snippet", "body_text"], ["from_json"], ["to_json", "cc_json"]);
    where.push(s.sql);
    binds.push(...s.binds);
  }
  if (q.cursor !== undefined) {
    where.push("id < ?");
    binds.push(decodeCursor(q.cursor));
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const sel = inboundSelect(q.viewer);
  const rows = await db.all<InboundRow>(
    `${sel.sql} ${whereSql} ORDER BY id DESC LIMIT ?`,
    ...sel.binds,
    ...binds,
    q.limit + 1,
  );
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map((r) => rowToListItem(r, q.viewer)),
    nextCursor: hasMore && last ? encodeCursor(last.id) : null,
  };
}

// ---- mailboxes ----
export async function listMailboxes(db: DbClient): Promise<mail.Mailbox[]> {
  const rows = await db.all<MailboxRow>(`SELECT * FROM mail_mailboxes ORDER BY id ASC`);
  return rows.map((r) => ({ address: r.address }));
}

export async function upsertMailbox(db: DbClient, id: string, address: string): Promise<void> {
  const now = nowIso();
  const upd = await db.run(`UPDATE mail_mailboxes SET address = ?, updated_at = ? WHERE id = ?`, address, now, id);
  if (upd.meta.changes === 0) {
    await db.run(
      `INSERT OR IGNORE INTO mail_mailboxes (id, address, provider, created_at, updated_at)
       VALUES (?, ?, 'cf-email-routing', ?, ?)`,
      id,
      address,
      now,
      now,
    );
  }
}

// ---- attachments (metadata; bytes live in R2) ----
export async function insertAttachment(
  db: DbClient,
  row: {
    id: string;
    messageKind: "sent" | "inbound";
    messageId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    r2Key: string;
    createdAt: string;
    // 0007: persistence status. Defaults to 'stored' (bytes in R2). A 'dropped_*' stub
    // carries r2Key='' and records an attachment we could NOT persist so the UI can
    // surface it instead of the file vanishing silently (改善#2).
    status?: AttachmentRow["status"];
  },
): Promise<void> {
  await db.run(
    `INSERT OR IGNORE INTO mail_attachments
       (id, message_kind, message_id, filename, mime_type, size_bytes, r2_key, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.messageKind,
    row.messageId,
    row.filename,
    row.mimeType,
    row.sizeBytes,
    row.r2Key,
    row.createdAt,
    row.status ?? "stored",
  );
}

/** All attachments for one message, oldest first (stable display order). */
export async function listAttachments(db: DbClient, kind: "sent" | "inbound", messageId: string): Promise<AttachmentRow[]> {
  return db.all<AttachmentRow>(
    `SELECT * FROM mail_attachments WHERE message_kind = ? AND message_id = ? ORDER BY created_at ASC, id ASC`,
    kind,
    messageId,
  );
}

/** One attachment by id, scoped to its owning message (download route: 404 on mismatch). */
export async function getAttachment(db: DbClient, kind: "sent" | "inbound", messageId: string, attId: string): Promise<AttachmentRow | null> {
  return db.first<AttachmentRow>(
    `SELECT * FROM mail_attachments WHERE id = ? AND message_kind = ? AND message_id = ?`,
    attId,
    kind,
    messageId,
  );
}

// ---- per-user thread flags (改善#8: star/archive/trash persisted server-side) ----
export interface UserFlagRow {
  owner_user_id: string;
  thread_id: string;
  starred: number;
  archived: number;
  trashed: number;
  // 完全に削除 (purge): per-user "permanently gone from MY mailbox" (no restore). Additive
  // (0009). Never triggers a physical row delete — only this viewer's list is filtered.
  purged: number;
  purged_at: string | null;
  // 返信不要 (0011): when the user dismissed the reply nudge; NULL = not dismissed.
  no_reply_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToFlags(r: UserFlagRow): mail.MailThreadFlags {
  return { threadId: r.thread_id, starred: r.starred === 1, archived: r.archived === 1, trashed: r.trashed === 1, purged: r.purged === 1, noReplyAt: r.no_reply_at ?? null };
}

/** Every flag row for one user (absent thread = all-false default; not returned). Only rows
 *  with at least one non-default flag matter to the client, but we return all stored rows. */
export async function listUserFlags(db: DbClient, ownerUserId: string): Promise<mail.MailThreadFlags[]> {
  const rows = await db.all<UserFlagRow>(`SELECT * FROM mail_user_flags WHERE owner_user_id = ?`, ownerUserId);
  return rows.map(rowToFlags);
}

/** Upsert one thread's flags for a user (PATCH semantics: only provided flags change; a
 *  first write defaults the others to false). Returns the resulting full flag state.
 *  Read-modify-write with INSERT OR REPLACE (the @dub/db namespace guard rejects
 *  `ON CONFLICT ... DO UPDATE SET`, reading "SET" as a foreign table). Flag toggles are
 *  per-user + low-contention, so the non-atomic read→write is acceptable; created_at is
 *  preserved from the existing row so the first-seen timestamp is stable. */
export async function upsertUserFlags(
  db: DbClient,
  ownerUserId: string,
  threadId: string,
  patch: mail.MailThreadFlagsPatch,
): Promise<mail.MailThreadFlags> {
  const now = nowIso();
  const existing = await db.first<UserFlagRow>(
    `SELECT * FROM mail_user_flags WHERE owner_user_id = ? AND thread_id = ?`,
    ownerUserId,
    threadId,
  );
  const cur = existing ? rowToFlags(existing) : { threadId, starred: false, archived: false, trashed: false, purged: false, noReplyAt: null };
  const merged: mail.MailThreadFlags = {
    threadId,
    starred: patch.starred ?? cur.starred,
    archived: patch.archived ?? cur.archived,
    trashed: patch.trashed ?? cur.trashed,
    purged: patch.purged ?? cur.purged,
    // 返信不要: every press re-stamps now (so mail received before it is covered); false clears.
    noReplyAt: patch.noReply === undefined ? cur.noReplyAt : patch.noReply ? now : null,
  };
  // purged_at: stamp the moment the conversation is first purged; keep the existing stamp on
  // later writes; clear it only if a caller ever un-purges (no UI does, but keep it honest).
  const purgedAt = merged.purged ? (existing?.purged_at ?? now) : null;
  await db.run(
    `INSERT OR REPLACE INTO mail_user_flags
       (owner_user_id, thread_id, starred, archived, trashed, purged, purged_at, no_reply_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ownerUserId,
    threadId,
    merged.starred ? 1 : 0,
    merged.archived ? 1 : 0,
    merged.trashed ? 1 : 0,
    merged.purged ? 1 : 0,
    purgedAt,
    merged.noReplyAt,
    existing?.created_at ?? now,
    now,
  );
  return merged;
}

// ---- scheduled send (予約送信) ----
export interface ScheduledRow {
  id: string;
  owner_user_id: string | null;
  to_json: string;
  cc_json: string | null;
  bcc_json: string | null; // 0020: envelope-only Bcc (NULL when none)
  subject: string;
  text_body: string;
  html_body: string | null;
  in_reply_to: string | null;
  from_address: string | null;
  scheduled_at: string;
  status: mail.ScheduledSendStatus;
  sent_message_id: string | null;
  error_code: string | null;
  attempts: number;
  snippet: string | null;
  created_at: string;
  updated_at: string;
}

function scheduledRowToListItem(r: ScheduledRow): mail.ScheduledSendListItem {
  const item: mail.ScheduledSendListItem = {
    id: r.id,
    to: parseAddresses(r.to_json),
    subject: r.subject,
    snippet: r.snippet ?? "",
    scheduledAt: r.scheduled_at,
    createdAt: r.created_at,
    status: r.status,
  };
  const cc = parseAddresses(r.cc_json);
  if (cc.length > 0) item.cc = cc;
  if (r.from_address) item.from = { email: r.from_address };
  if (r.in_reply_to) item.inReplyTo = r.in_reply_to;
  if (r.sent_message_id) item.sentMessageId = r.sent_message_id;
  if (r.error_code) item.errorCode = r.error_code;
  return item;
}

function scheduledRowToDetail(r: ScheduledRow): mail.ScheduledSendDetail {
  const detail: mail.ScheduledSendDetail = { ...scheduledRowToListItem(r), textBody: r.text_body };
  if (r.html_body !== null && r.html_body !== "") detail.htmlBody = r.html_body;
  const bcc = parseAddresses(r.bcc_json);
  if (bcc.length > 0) detail.bcc = bcc;
  return detail;
}

// ---- scheduled-send attachments (0020; metadata here, bytes in R2) ----
export interface ScheduledAttachmentRow {
  id: string;
  scheduled_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  r2_key: string;
  created_at: string;
}

export async function insertScheduledAttachment(
  db: DbClient,
  row: { id: string; scheduledId: string; filename: string; mimeType: string; sizeBytes: number; r2Key: string },
): Promise<void> {
  await db.run(
    `INSERT INTO mail_scheduled_attachments (id, scheduled_id, filename, mime_type, size_bytes, r2_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.scheduledId,
    row.filename,
    row.mimeType,
    row.sizeBytes,
    row.r2Key,
    nowIso(),
  );
}

/** Parked files of one or more schedules, in attach order (rowid = insert order). */
export async function listScheduledAttachments(db: DbClient, scheduledIds: readonly string[]): Promise<ScheduledAttachmentRow[]> {
  if (scheduledIds.length === 0) return [];
  const marks = scheduledIds.map(() => "?").join(", ");
  return db.all<ScheduledAttachmentRow>(
    `SELECT * FROM mail_scheduled_attachments WHERE scheduled_id IN (${marks}) ORDER BY rowid ASC`,
    ...scheduledIds,
  );
}

function scheduledAttachmentMeta(r: ScheduledAttachmentRow): mail.MailAttachment {
  return { id: r.id, filename: r.filename, contentType: r.mime_type, sizeBytes: r.size_bytes };
}

/** Decorate list/detail items with their parked-file metadata (absent when none). */
async function withScheduledAttachments<T extends mail.ScheduledSendListItem>(db: DbClient, items: T[]): Promise<T[]> {
  const rows = await listScheduledAttachments(db, items.map((i) => i.id));
  if (rows.length === 0) return items;
  for (const item of items) {
    const mine = rows.filter((r) => r.scheduled_id === item.id).map(scheduledAttachmentMeta);
    if (mine.length > 0) item.attachments = mine;
  }
  return items;
}

/** Park a compose for future delivery. status='scheduled'. */
export async function insertScheduled(
  db: DbClient,
  row: {
    id: string;
    ownerUserId: string | null;
    toJson: string;
    ccJson: string | null;
    bccJson?: string | null;
    subject: string;
    textBody: string;
    htmlBody: string | null;
    inReplyTo: string | null;
    fromAddress: string | null;
    scheduledAt: string;
  },
): Promise<void> {
  const now = nowIso();
  await db.run(
    `INSERT INTO mail_scheduled
       (id, owner_user_id, to_json, cc_json, bcc_json, subject, text_body, html_body, in_reply_to,
        from_address, scheduled_at, status, sent_message_id, error_code, attempts, snippet,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', NULL, NULL, 0, ?, ?, ?)`,
    row.id,
    row.ownerUserId,
    row.toJson,
    row.ccJson,
    row.bccJson ?? null,
    row.subject,
    row.textBody,
    row.htmlBody,
    row.inReplyTo,
    row.fromAddress,
    row.scheduledAt,
    snippetOf(row.textBody),
    now,
    now,
  );
}

/** List a user's still-'scheduled' sends, soonest due first. Oversight (mail:read_all)
 *  drops the owner filter. id-based opaque cursor (schedule ids are ULIDs). */
export async function listScheduled(
  db: DbClient,
  q: { ownerUserId: MailScope; cursor?: string; limit: number },
): Promise<common.Paginated<mail.ScheduledSendListItem>> {
  const where: string[] = ["status = 'scheduled'"];
  const binds: unknown[] = [];
  if (!isReadAll(q.ownerUserId)) {
    where.push("owner_user_id = ?");
    binds.push(q.ownerUserId);
  }
  if (q.cursor !== undefined) {
    where.push("id > ?");
    binds.push(decodeCursor(q.cursor));
  }
  const rows = await db.all<ScheduledRow>(
    `SELECT * FROM mail_scheduled WHERE ${where.join(" AND ")} ORDER BY scheduled_at ASC, id ASC LIMIT ?`,
    ...binds,
    q.limit + 1,
  );
  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: await withScheduledAttachments(db, page.map(scheduledRowToListItem)),
    nextCursor: hasMore && last ? encodeCursor(last.id) : null,
  };
}

/** Read one scheduled send (any status) scoped to its owner (fail-closed 404). */
export async function getScheduledDetail(db: DbClient, id: string, scope: MailScope): Promise<mail.ScheduledSendDetail | null> {
  const binds: unknown[] = [id];
  let sql = `SELECT * FROM mail_scheduled WHERE id = ?`;
  if (!isReadAll(scope)) {
    sql += ` AND owner_user_id = ?`;
    binds.push(scope);
  }
  const row = await db.first<ScheduledRow>(sql, ...binds);
  if (!row) return null;
  const [detail] = await withScheduledAttachments(db, [scheduledRowToDetail(row)]);
  return detail ?? null;
}

/** Raw scheduled row (owner-scoped) — used by edit/cancel to check current status. */
export async function findScheduledRow(db: DbClient, id: string, scope: MailScope): Promise<ScheduledRow | null> {
  const binds: unknown[] = [id];
  let sql = `SELECT * FROM mail_scheduled WHERE id = ?`;
  if (!isReadAll(scope)) {
    sql += ` AND owner_user_id = ?`;
    binds.push(scope);
  }
  return db.first<ScheduledRow>(sql, ...binds);
}

/** Apply an edit/reschedule to a still-'scheduled' row. Returns rows changed (0 = the row
 *  is no longer 'scheduled' — already sent/canceled — so the edit is rejected upstream). */
export async function updateScheduled(
  db: DbClient,
  id: string,
  scope: MailScope,
  patch: {
    toJson?: string;
    ccJson?: string | null;
    subject?: string;
    textBody?: string;
    htmlBody?: string | null;
    scheduledAt?: string;
  },
): Promise<number> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.toJson !== undefined) { sets.push("to_json = ?"); binds.push(patch.toJson); }
  if (patch.ccJson !== undefined) { sets.push("cc_json = ?"); binds.push(patch.ccJson); }
  if (patch.subject !== undefined) { sets.push("subject = ?"); binds.push(patch.subject); }
  if (patch.textBody !== undefined) {
    sets.push("text_body = ?"); binds.push(patch.textBody);
    sets.push("snippet = ?"); binds.push(snippetOf(patch.textBody));
  }
  if (patch.htmlBody !== undefined) { sets.push("html_body = ?"); binds.push(patch.htmlBody); }
  if (patch.scheduledAt !== undefined) { sets.push("scheduled_at = ?"); binds.push(patch.scheduledAt); }
  sets.push("updated_at = ?"); binds.push(nowIso());

  const where: string[] = ["id = ?", "status = 'scheduled'"];
  binds.push(id);
  if (!isReadAll(scope)) { where.push("owner_user_id = ?"); binds.push(scope); }

  const res = await db.run(`UPDATE mail_scheduled SET ${sets.join(", ")} WHERE ${where.join(" AND ")}`, ...binds);
  return res.meta.changes;
}

/** Cancel a still-'scheduled' send. Returns rows changed (0 = not cancelable anymore). */
export async function cancelScheduled(db: DbClient, id: string, scope: MailScope): Promise<number> {
  const binds: unknown[] = [nowIso(), id];
  let sql = `UPDATE mail_scheduled SET status = 'canceled', updated_at = ? WHERE id = ? AND status = 'scheduled'`;
  if (!isReadAll(scope)) { sql += ` AND owner_user_id = ?`; binds.push(scope); }
  const res = await db.run(sql, ...binds);
  return res.meta.changes;
}

/** Claim due scheduled rows for the drain (status='scheduled' AND scheduled_at <= now),
 *  soonest first, bounded. Read-only claim; the drain marks each row sent/failed after it
 *  attempts delivery, so a re-run before that write simply re-attempts (send core is
 *  idempotency-keyed by row id, so no double send). */
export async function claimDueScheduled(db: DbClient, nowIsoStr: string, limit: number): Promise<ScheduledRow[]> {
  const rows = await db.all<ScheduledRow>(
    `SELECT * FROM mail_scheduled WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at ASC LIMIT ?`,
    nowIsoStr,
    limit,
  );
  return rows;
}

/** Mark a scheduled row delivered (records the RFC Message-Id the send produced). */
export async function markScheduledSent(db: DbClient, id: string, sentMessageId: string, attempts: number): Promise<void> {
  await db.run(
    `UPDATE mail_scheduled SET status = 'sent', sent_message_id = ?, error_code = NULL, attempts = ?, updated_at = ?
       WHERE id = ? AND status = 'scheduled'`,
    sentMessageId,
    attempts,
    nowIso(),
    id,
  );
}

/** Record a failed drain attempt. Below maxAttempts the row stays 'scheduled' (retried on
 *  the next drain); at/over it the row goes terminal 'failed' so it stops churning. */
export async function markScheduledAttemptFailed(db: DbClient, id: string, errorCode: string, attempts: number, maxAttempts: number): Promise<void> {
  const terminal = attempts >= maxAttempts;
  await db.run(
    `UPDATE mail_scheduled SET status = ?, error_code = ?, attempts = ?, updated_at = ?
       WHERE id = ? AND status = 'scheduled'`,
    terminal ? "failed" : "scheduled",
    errorCode,
    attempts,
    nowIso(),
    id,
  );
}

// ---- id mints ----
export const newSendLogId = (): string => newId("maillog");
export const newInboundId = (): string => newId("mailin");
export const newDeliveryId = (): string => newId("maildlv");
export const newAttachmentId = (): string => newId("mailatt");
export const newScheduledId = (): string => newId("mailsch");
