// Shared sending addresses (共用アドレスから送る, migration 0027). A member picks a shared address
// (info@) as the From in compose; the recipient sees that address with its display name, and
// the send log keeps who actually sent it. When the recipient answers, the reply reaches the
// shared address as always AND the member who sent the mail (matched by our Message-ID in its
// In-Reply-To / References). Who may pick an address is checked on every send, against
// member-service: every linked 運営メンバー (and any `mail:admin` holder), or one team's members.
import type { Fetcher } from "@cloudflare/workers-types";
import type { DbClient } from "@dub/db";
import { createAuthClient } from "@dub/auth-client";
import { createServiceClient, type RequestContext } from "@dub/http";
import { common, type mail } from "@dub/types";
import { SERVICE_NAME } from "./config";
import { isMissingTable, TEAM_LIST_COLUMNS, type TeamListRow } from "./team-list";

export interface SharedMailboxRow {
  id: string;
  address: string;
  display_name: string;
  signature: string;
  allow: mail.MailSharedMailboxAllow;
  team_id: string | null;
  updated_at: string;
  /** Set when the row is a team mailing list (0024) offered as a From, not a 0027 row. */
  team_list?: true;
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

// ---- team mailing lists as a From (チームのメーリングリストから送る) ----
// A team list (mail_team_list, 0024) can be picked like a shared mailbox, by that team's members
// only (the same per-send member-service check as a team-scoped shared mailbox). It has no
// stored display name or signature: both come from the team's name, in info@'s format. A 0027
// row and a team list never share an address (the admin routes refuse it), and a 0027 row wins.

/** Team names from member-service. Never throws: without a name the From is the bare address. */
async function teamNames(member: Fetcher | undefined, ctx: RequestContext, teamIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(teamIds)].filter(Boolean);
  if (!member || ids.length === 0) return new Map();
  try {
    const client = createServiceClient(member, { service: "member-service", caller: SERVICE_NAME });
    const { teams } = await client.get<{ teams: Array<{ id: string; name: string }> }>(ctx, `/members/internal/team-names?teamIds=${ids.map(encodeURIComponent).join(",")}`);
    return new Map((Array.isArray(teams) ? teams : []).map((t) => [t.id, String(t.name ?? "").replace(/[\r\n]+/g, " ").trim()]));
  } catch {
    return new Map();
  }
}

/** info@'s signature format (`--` / name / address) for a team list. */
export function teamListSignature(name: string | undefined, address: string): string {
  return name ? `--\n${name}\n${address}` : `--\n${address}`;
}

function teamListAsMailbox(row: TeamListRow, name: string | undefined): SharedMailboxRow {
  return {
    id: row.id,
    address: row.address,
    display_name: name ?? "",
    signature: teamListSignature(name, row.address),
    allow: "team",
    team_id: row.team_id,
    updated_at: row.created_at,
    team_list: true,
  };
}

async function activeTeamLists(db: DbClient, address?: string): Promise<TeamListRow[]> {
  try {
    return address
      ? await db.all<TeamListRow>(`SELECT ${TEAM_LIST_COLUMNS} FROM mail_team_list WHERE address = ? AND deleted_at IS NULL`, address)
      : await db.all<TeamListRow>(`SELECT ${TEAM_LIST_COLUMNS} FROM mail_team_list WHERE deleted_at IS NULL ORDER BY address`);
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

/** A From a member may pick at this address: a shared mailbox (0027) or a team list (0024). */
export async function findSendableMailbox(db: DbClient, member: Fetcher | undefined, ctx: RequestContext, address: string | null | undefined): Promise<SharedMailboxRow | null> {
  const shared = await findActiveSharedMailbox(db, address);
  if (shared) return shared;
  const normalized = address?.trim().toLowerCase();
  if (!normalized) return null;
  const [list] = await activeTeamLists(db, normalized);
  if (!list) return null;
  return teamListAsMailbox(list, (await teamNames(member, ctx, [list.team_id])).get(list.team_id));
}

/** Every pickable From other than the user's own: shared mailboxes, then team lists. */
export async function listSendableMailboxes(db: DbClient, member: Fetcher | undefined, ctx: RequestContext): Promise<SharedMailboxRow[]> {
  const shared = await listActiveSharedMailboxes(db);
  const taken = new Set(shared.map((r) => r.address));
  const lists = (await activeTeamLists(db)).filter((l) => !taken.has(l.address));
  const names = await teamNames(member, ctx, lists.map((l) => l.team_id));
  return [...shared, ...lists.map((l) => teamListAsMailbox(l, names.get(l.team_id)))];
}

/** Holds `mail:admin`? Asked fresh each time (a dangerous key is never cached). An identity
 *  outage answers false, so the roster check still decides. */
async function isMailAdmin(identityBinding: Fetcher | undefined, ctx: RequestContext, userId: string): Promise<boolean> {
  if (!identityBinding) return false;
  try {
    const client = createAuthClient({ identityBinding, serviceName: SERVICE_NAME });
    return await client.hasPermission(userId, common.DUB_DEFAULT_ORG_ID, { permission: "mail:admin" }, { requestId: ctx.requestId });
  } catch {
    return false;
  }
}

/**
 * May `userId` send as this shared mailbox? Asked on every send: leaving the team (or 運営, or
 * losing `mail:admin`) removes the right at once. An `all_members` address is also open to a
 * `mail:admin` holder with no 名簿 row (admin@); a `team` one stays that team's only.
 */
export async function memberMaySend(
  member: Fetcher | undefined,
  ctx: RequestContext,
  row: SharedMailboxRow,
  userId: string,
  identityBinding?: Fetcher,
): Promise<boolean> {
  if (row.allow !== "team" && (await isMailAdmin(identityBinding, ctx, userId))) return true;
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
