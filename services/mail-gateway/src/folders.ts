// Folder views for the inbox list (GET /mail/messages?folder=, GET /mail/counts).
//
// The list used to page MESSAGES (LIMIT 50) and leave folder placement to the client, which
// then dropped blocked senders (0021) and archived/trashed/purged conversations from the
// page it got — so a page could show far fewer than 50 rows. Here every filter runs in SQL
// BEFORE the limit and the unit is the CONVERSATION:
//   1. per thread (inner GROUP BY over the viewer's in-scope inbound rows): newest id, how
//      many messages are NOT from a blocked sender, whether any is mine / unread for the
//      viewer;
//   2. joined with the viewer's own flags (mail_user_flags) and filtered by the view;
//   3. ordered by newest id, LIMIT n+1 (cursor = newest id of the last thread).
// A conversation is "blocked" when none of its in-scope messages has an unblocked sender —
// the same rule the client uses for its optimistic re-filing — so a mixed conversation stays
// in the inbox. Read-only: nothing is stamped on any row; unblocking restores everything.
import type { DbClient } from "@dub/db";
import type { mail } from "@dub/types";
import {
  decodeCursor,
  encodeCursor,
  inboundOwnerClause,
  inboundSearchClause,
  inboundSelect,
  rowToListItem,
  type InboundRow,
  type InboundScope,
} from "./repo";

type View = mail.MailFolderView;

interface Sql {
  sql: string;
  binds: unknown[];
}

/** Message-level "sender is on the viewer's block list": exact address (PK lookup on
 *  (owner_user_id, value)) or a domain row (0022 index) matching the domain or any subdomain. */
function blockedSenderSql(viewer: string): Sql {
  const addr = "lower(trim(json_extract(CASE WHEN json_valid(mail_inbound.from_json) THEN mail_inbound.from_json ELSE '{}' END, '$.email')))";
  return {
    sql:
      `(EXISTS (SELECT 1 FROM mail_sender_blocks sba WHERE sba.owner_user_id = ? AND sba.value = ${addr} AND sba.deleted_at IS NULL)` +
      ` OR EXISTS (SELECT 1 FROM mail_sender_blocks sbd WHERE sbd.owner_user_id = ? AND sbd.kind = 'domain' AND sbd.deleted_at IS NULL` +
      ` AND (${addr} LIKE '%@' || sbd.value OR ${addr} LIKE '%.' || sbd.value)))`,
    binds: [viewer, viewer],
  };
}

/** Per-thread attributes over the viewer's in-scope inbound rows (optionally search-narrowed). */
function threadAttrsSql(scope: InboundScope, viewer: string, q: string | undefined): Sql {
  const blk = blockedSenderSql(viewer);
  const own = "EXISTS (SELECT 1 FROM mail_inbound_delivery vd WHERE vd.inbound_id = mail_inbound.id AND vd.owner_user_id = ?)";
  const ownRead = "EXISTS (SELECT 1 FROM mail_inbound_delivery vr WHERE vr.inbound_id = mail_inbound.id AND vr.owner_user_id = ? AND vr.read_at IS NOT NULL)";
  // Mirrors rowToListItem: mine = a delivery of the viewer's (or the legacy owner column);
  // unread = the viewer's own copy is unread (or, legacy row without deliveries, read_at NULL).
  const mine = `(mail_inbound.owner_user_id = ? OR ${own})`;
  const unread = `((${own} AND NOT ${ownRead}) OR (NOT ${own} AND mail_inbound.owner_user_id = ? AND mail_inbound.read_at IS NULL))`;
  const select =
    `SELECT thread_id, MAX(id) AS last_id,` +
    ` SUM(CASE WHEN ${blk.sql} THEN 0 ELSE 1 END) AS unblocked_n,` +
    ` MAX(CASE WHEN ${mine} THEN 1 ELSE 0 END) AS mine_n,` +
    ` MAX(CASE WHEN ${unread} THEN 1 ELSE 0 END) AS unread_n` +
    ` FROM mail_inbound`;
  const binds: unknown[] = [...blk.binds, viewer, viewer, viewer, viewer, viewer, viewer];
  const where: string[] = [];
  const owner = inboundOwnerClause(scope);
  if (owner) {
    where.push(owner.sql);
    binds.push(...owner.binds);
  }
  if (q !== undefined) {
    const s = inboundSearchClause(q);
    where.push(s.sql);
    binds.push(...s.binds);
  }
  return { sql: `${select}${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} GROUP BY thread_id`, binds };
}

/** View predicate over `t` (thread attrs) LEFT JOIN `uf` (viewer flags). Mirrors the
 *  client's inFolder: Trash wins over everything, blocked conversations live only under
 *  ブロック済み, purged (完全に削除) conversations never show. */
const live = "COALESCE(uf.purged, 0) = 0";
const notTrashed = "COALESCE(uf.trashed, 0) = 0";
const notArchived = "COALESCE(uf.archived, 0) = 0";
const blockedThread = "t.unblocked_n = 0";
const unblockedThread = "t.unblocked_n > 0";
const inbox = `${live} AND ${notTrashed} AND ${notArchived} AND ${unblockedThread}`;
export const VIEW_PREDICATE: Record<View, string> = {
  inbox,
  mine: `${inbox} AND t.mine_n = 1`,
  others: `${inbox} AND t.mine_n = 0`,
  starred: `${live} AND ${notTrashed} AND COALESCE(uf.starred, 0) = 1 AND ${unblockedThread}`,
  archive: `${live} AND ${notTrashed} AND COALESCE(uf.archived, 0) = 1 AND ${unblockedThread}`,
  trash: `${live} AND COALESCE(uf.trashed, 0) = 1`,
  blocked: `${live} AND ${notTrashed} AND ${blockedThread}`,
  all: `${live} AND ${notTrashed} AND ${unblockedThread}`,
};

function viewFrom(scope: InboundScope, viewer: string, q: string | undefined): Sql {
  const attrs = threadAttrsSql(scope, viewer, q);
  return {
    sql: `FROM (${attrs.sql}) t LEFT JOIN mail_user_flags uf ON uf.owner_user_id = ? AND uf.thread_id = t.thread_id`,
    binds: [...attrs.binds, viewer],
  };
}

/** One page of a folder view: the in-scope messages of exactly `limit` conversations
 *  (fewer only on the last page), newest conversation first, plus the view's total. */
export async function listInboundFolder(
  db: DbClient,
  q: { scope: InboundScope; viewer: string; folder: View; cursor?: string; limit: number; q?: string },
): Promise<mail.MailMessagePage> {
  const from = viewFrom(q.scope, q.viewer, q.q);
  const pred = VIEW_PREDICATE[q.folder];
  const cursorSql = q.cursor !== undefined ? " AND t.last_id < ?" : "";
  const cursorBinds = q.cursor !== undefined ? [decodeCursor(q.cursor)] : [];
  const threads = await db.all<{ thread_id: string; last_id: string }>(
    `SELECT t.thread_id AS thread_id, t.last_id AS last_id ${from.sql} WHERE ${pred}${cursorSql} ORDER BY t.last_id DESC LIMIT ?`,
    ...from.binds,
    ...cursorBinds,
    q.limit + 1,
  );
  const hasMore = threads.length > q.limit;
  const page = hasMore ? threads.slice(0, q.limit) : threads;
  const totalRow = await db.first<{ n: number }>(`SELECT COUNT(*) AS n ${from.sql} WHERE ${pred}`, ...from.binds);
  const total = Number(totalRow?.n ?? 0);
  if (page.length === 0) return { items: [], nextCursor: null, total };

  const sel = inboundSelect(q.viewer);
  const where = ["thread_id IN (SELECT value FROM json_each(?))"];
  const binds: unknown[] = [JSON.stringify(page.map((t) => t.thread_id))];
  const owner = inboundOwnerClause(q.scope);
  if (owner) {
    where.push(owner.sql);
    binds.push(...owner.binds);
  }
  if (q.q !== undefined) {
    const s = inboundSearchClause(q.q);
    where.push(s.sql);
    binds.push(...s.binds);
  }
  const rows = await db.all<InboundRow>(`${sel.sql} WHERE ${where.join(" AND ")} ORDER BY id DESC`, ...sel.binds, ...binds);
  const last = page[page.length - 1]!;
  return {
    items: rows.map((r) => rowToListItem(r, q.viewer)),
    nextCursor: hasMore ? encodeCursor(last.last_id) : null,
    total,
  };
}

/** Conversations + unread conversations per view, for the sidebar (one aggregate query). */
export async function countFolders(db: DbClient, scope: InboundScope, viewer: string): Promise<mail.MailFolderCounts> {
  const from = viewFrom(scope, viewer, undefined);
  const views = ["inbox", "mine", "others", "starred", "archive", "trash", "blocked"] as const;
  const cols = views.flatMap((v) => [
    `SUM(CASE WHEN ${VIEW_PREDICATE[v]} THEN 1 ELSE 0 END) AS ${v}_total`,
    // ブロック済み never counts as unread (no badge / no notification for blocked mail).
    `SUM(CASE WHEN ${v === "blocked" ? "0 = 1" : `${VIEW_PREDICATE[v]} AND t.unread_n = 1`} THEN 1 ELSE 0 END) AS ${v}_unread`,
  ]);
  const row = (await db.first<Record<string, number | null>>(`SELECT ${cols.join(", ")} ${from.sql}`, ...from.binds)) ?? {};
  const out = {} as mail.MailFolderCounts;
  for (const v of views) out[v] = { total: Number(row[`${v}_total`] ?? 0), unread: Number(row[`${v}_unread`] ?? 0) };
  return out;
}

