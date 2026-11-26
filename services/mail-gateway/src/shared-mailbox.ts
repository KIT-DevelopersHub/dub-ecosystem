// Shared sending addresses (共用アドレスから送る, migration 0027). A member picks a shared address
// (info@) as the From in compose; the recipient sees that address with its display name, and
// the send log keeps who actually sent it. When the recipient answers, the reply reaches the
// shared address as always AND the member who sent the mail (matched by our Message-ID in its
// In-Reply-To / References). Who may pick an address is checked on every send, against
// member-service: every linked 運営メンバー, or one team's members.
import type { Fetcher } from "@cloudflare/workers-types";
import type { DbClient } from "@dub/db";
import { createServiceClient, type RequestContext } from "@dub/http";
import type { mail } from "@dub/types";
import { SERVICE_NAME } from "./config";
import { isMissingTable } from "./team-list";

export interface SharedMailboxRow {
  id: string;
  address: string;
  display_name: string;
  signature: string;
  allow: mail.MailSharedMailboxAllow;
  team_id: string | null;
  updated_at: string;
}

export const SHARED_MAILBOX_COLUMNS = `id, address, display_name, signature, allow, team_id, updated_at`;

/** The live shared mailbox at this address, or null. Before 0027 is applied there is none. */
export async function findActiveSharedMailbox(db: DbClient, address: string | null | undefined): Promise<SharedMailboxRow | null> {
  const normalized = address?.trim().toLowerCase();
  if (!normalized) return null;
  try {
    return (await db.first<SharedMailboxRow>(`SELECT ${SHARED_MAILBOX_COLUMNS} FROM mail_shared_mailbox WHERE address = ? AND deleted_at IS NULL`, normalized)) ?? null;
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

export async function listActiveSharedMailboxes(db: DbClient): Promise<SharedMailboxRow[]> {
  try {
    return await db.all<SharedMailboxRow>(`SELECT ${SHARED_MAILBOX_COLUMNS} FROM mail_shared_mailbox WHERE deleted_at IS NULL ORDER BY address`);
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

export function toSharedMailboxDto(row: SharedMailboxRow): mail.MailSharedMailbox {
  return {
    id: row.id,
    address: row.address,
    displayName: row.display_name,
    signature: row.signature,
    allow: row.allow,
    teamId: row.team_id,
    updatedAt: row.updated_at,
  };
}

/**
 * May `userId` send as this shared mailbox? Asked of member-service on every send: leaving the
 * team (or 運営) removes the right at once. Without the member binding nobody may.
 */
export async function memberMaySend(member: Fetcher | undefined, ctx: RequestContext, row: SharedMailboxRow, userId: string): Promise<boolean> {
  if (!member) return false;
  let query: string;
  if (row.allow === "team") {
    if (!row.team_id) return false;
    query = `teamIds=${encodeURIComponent(row.team_id)}&excludeDeclined=1`;
  } else {
    query = "all=1&excludeDeclined=1";
  }
  const client = createServiceClient(member, { service: "member-service", caller: SERVICE_NAME });
  const { userIds } = await client.get<{ userIds: string[] }>(ctx, `/members/internal/team-members?${query}`);
  return Array.isArray(userIds) && userIds.includes(userId);
}

// RFC 5322 specials: a display name holding any of them is sent as a quoted-string.
const SPECIALS = /[()<>\[\]:;@\\,."]/;

/** `表示名 <address>` for the From header, or the bare address when there is no name. */
export function displayFrom(address: string, name: string | null | undefined): string {
  const n = (name ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!n) return address;
  const quoted = SPECIALS.test(n) ? `"${n.replace(/(["\\])/g, "\\$1")}"` : n;
  return `${quoted} <${address}>`;
}

/**
 * The members who sent, as `sharedAddress`, one of the mails this message answers. `refs` are
 * the In-Reply-To / References ids; ours are `<send-log id>@domain`. A ref we cannot match
 * (another client's id, or a provider that rewrote ours) is skipped, and the mail then stays
 * only in the shared mailbox's inbox, as before. Never throws: delivery to the sender is extra.
 */
export async function sharedSendersFor(db: DbClient, sharedAddress: string, refs: readonly string[]): Promise<string[]> {
  const address = sharedAddress.trim().toLowerCase();
  const ids = [...new Set(refs.map((r) => (r.trim().replace(/^<|>$/g, "").split("@")[0] ?? "").trim()).filter((id) => id.startsWith("maillog_")))];
  if (!address || ids.length === 0) return [];
  try {
    const rows = await db.all<{ owner_user_id: string }>(
      `SELECT DISTINCT owner_user_id FROM mail_send_log
        WHERE id IN (SELECT value FROM json_each(?)) AND shared_mailbox = ? AND owner_user_id IS NOT NULL`,
      JSON.stringify(ids.slice(0, 50)),
      address,
    );
    return rows.map((r) => r.owner_user_id);
  } catch {
    return [];
  }
}
