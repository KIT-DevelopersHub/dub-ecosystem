// Per-user sender block list (この送信者をブロック, migration 0021).
//
// Blocking is a VIEW decision, never a delete (no-silent-delete policy, #696): inbound mail
// from a blocked sender is stored exactly as before, and every inbound read marks the items
// whose From matches the VIEWER's own list as `blocked`. Matching at query time (instead of
// stamping rows at ingest) is what makes unblocking a plain row delete that restores every
// past message, and keeps one sender's block personal to the account that set it.
import { DubError } from "@dub/errors";
import type { DbClient } from "@dub/db";
import { nowIso } from "@dub/db";
import { mail } from "@dub/types";
import { COMPANY_MAIL_DOMAIN } from "./from";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

interface BlockRow {
  owner_user_id: string;
  value: string;
  kind: mail.MailSenderBlockKind;
  created_at: string;
  deleted_at: string | null;
}

const toBlock = (r: BlockRow): mail.MailSenderBlock => ({ value: r.value, kind: r.kind, createdAt: r.created_at });

/** Validate + normalize a POST /mail/blocks body. Lowercases, strips a leading "@" from a
 *  domain, and infers `kind` from the value when omitted. 400 on anything malformed. */
export function parseBlockRequest(body: unknown): { value: string; kind: mail.MailSenderBlockKind } {
  if (body === null || typeof body !== "object") {
    throw new DubError("MAIL_INVALID_REQUEST", "block request must be an object", { status: 400 });
  }
  const src = body as Record<string, unknown>;
  if (typeof src.value !== "string" || src.value.trim() === "") {
    throw new DubError("MAIL_INVALID_REQUEST", "value (address or domain) required", { status: 400 });
  }
  if (src.kind !== undefined && src.kind !== "address" && src.kind !== "domain") {
    throw new DubError("MAIL_INVALID_REQUEST", 'kind must be "address" or "domain"', { status: 400 });
  }
  const raw = src.value.trim().toLowerCase();
  const kind: mail.MailSenderBlockKind = (src.kind as mail.MailSenderBlockKind | undefined) ?? (raw.includes("@") && !raw.startsWith("@") ? "address" : "domain");
  if (kind === "address") {
    if (!EMAIL_RE.test(raw)) throw new DubError("MAIL_INVALID_REQUEST", `invalid email address: ${raw}`, { status: 400 });
    return { value: raw, kind };
  }
  // A domain block given a full address ("a@spam.example") blocks that address's domain.
  const domain = raw.includes("@") ? raw.slice(raw.lastIndexOf("@") + 1) : raw;
  if (!DOMAIN_RE.test(domain)) throw new DubError("MAIL_INVALID_REQUEST", `invalid domain: ${domain}`, { status: 400 });
  return { value: domain, kind };
}

/** Normalize a path segment for DELETE /mail/blocks/:value (same casing rules as create). */
export function normalizeBlockValue(value: string): string {
  const v = value.trim().toLowerCase();
  return v.startsWith("@") ? v.slice(1) : v;
}

/** Refuse blocks that would hide the caller's own mail: their own address, or the whole
 *  company domain (every colleague + every shared mailbox at once). */
export function assertBlockAllowed(req: { value: string; kind: mail.MailSenderBlockKind }, ownAddress: string | null): void {
  if (req.kind === "domain" && (req.value === COMPANY_MAIL_DOMAIN || req.value.endsWith(`.${COMPANY_MAIL_DOMAIN}`))) {
    throw new DubError("MAIL_INVALID_REQUEST", `cannot block the organization domain ${COMPANY_MAIL_DOMAIN}`, { status: 400 });
  }
  if (req.kind === "address" && ownAddress && req.value === ownAddress.trim().toLowerCase()) {
    throw new DubError("MAIL_INVALID_REQUEST", "cannot block your own address", { status: 400 });
  }
}

export async function listBlocks(db: DbClient, ownerUserId: string): Promise<mail.MailSenderBlock[]> {
  const rows = await db.all<BlockRow>(
    `SELECT * FROM mail_sender_blocks WHERE owner_user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, value ASC`,
    ownerUserId,
  );
  return rows.map(toBlock);
}

/** Add one entry. Idempotent: re-blocking an active entry returns it (`created: false`);
 *  a previously unblocked (soft-deleted) row is revived. 409 once the per-user cap is reached. */
export async function addBlock(
  db: DbClient,
  ownerUserId: string,
  req: { value: string; kind: mail.MailSenderBlockKind },
): Promise<{ block: mail.MailSenderBlock; created: boolean }> {
  const existing = await db.first<BlockRow>(
    `SELECT * FROM mail_sender_blocks WHERE owner_user_id = ? AND value = ?`,
    ownerUserId,
    req.value,
  );
  if (existing && existing.deleted_at === null) return { block: toBlock(existing), created: false };
  const count = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM mail_sender_blocks WHERE owner_user_id = ? AND deleted_at IS NULL`,
    ownerUserId,
  );
  if ((count?.n ?? 0) >= mail.MAIL_SENDER_BLOCK_LIMIT) {
    throw new DubError("MAIL_BLOCK_LIMIT", `block list is full (max ${mail.MAIL_SENDER_BLOCK_LIMIT})`, { status: 409 });
  }
  const now = nowIso();
  await db.run(
    `INSERT OR REPLACE INTO mail_sender_blocks (owner_user_id, value, kind, created_at, deleted_at) VALUES (?, ?, ?, ?, NULL)`,
    ownerUserId,
    req.value,
    req.kind,
    now,
  );
  return { block: { value: req.value, kind: req.kind, createdAt: now }, created: true };
}

/** Unblock one entry — a soft delete (deleted_at stamped, row kept for the audit trail).
 *  Returns false when there was no active entry (route answers 404). */
export async function removeBlock(db: DbClient, ownerUserId: string, value: string): Promise<boolean> {
  const res = await db.run(
    `UPDATE mail_sender_blocks SET deleted_at = ? WHERE owner_user_id = ? AND value = ? AND deleted_at IS NULL`,
    nowIso(),
    ownerUserId,
    value,
  );
  return res.meta.changes > 0;
}

/** Compiled block list for fast per-message matching. */
export interface BlockMatcher {
  readonly size: number;
  matches(email: string | undefined | null): boolean;
}

export function blockMatcher(blocks: readonly Pick<mail.MailSenderBlock, "value" | "kind">[]): BlockMatcher {
  const addresses = new Set<string>();
  const domains = new Set<string>();
  for (const b of blocks) (b.kind === "domain" ? domains : addresses).add(b.value);
  return {
    size: addresses.size + domains.size,
    matches(email) {
      if (!email) return false;
      const e = email.trim().toLowerCase();
      if (addresses.has(e)) return true;
      const at = e.lastIndexOf("@");
      if (at < 0 || domains.size === 0) return false;
      // Exact domain or any subdomain of a blocked domain (mail.spam.example ⊂ spam.example).
      let d = e.slice(at + 1);
      while (d.includes(".")) {
        if (domains.has(d)) return true;
        d = d.slice(d.indexOf(".") + 1);
      }
      return false;
    },
  };
}

/** The viewer's matcher (empty when the list is empty / the viewer is unknown). */
export async function loadMatcher(db: DbClient, viewer: string | undefined): Promise<BlockMatcher> {
  if (!viewer) return blockMatcher([]);
  return blockMatcher(await listBlocks(db, viewer));
}

/** Stamp `blocked: true` on the items whose sender is on the viewer's list (in place). */
export function markBlocked<T extends { from: mail.MailAddress; blocked?: boolean }>(items: T[], matcher: BlockMatcher): T[] {
  if (matcher.size === 0) return items;
  for (const it of items) if (matcher.matches(it.from?.email)) it.blocked = true;
  return items;
}
