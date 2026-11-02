// Per-user opt-in auto-forward (Gmail 自動転送, migration 0023).
//
// A user registers ONE personal address (typically Gmail). We create it as a Cloudflare
// Email Routing destination address, which makes Cloudflare mail a verification link to it:
// clicking that link is the user's proof of ownership, and it is also the precondition for
// message.forward() to reach the address at all ($0: Email Routing is free, no send quota).
// Only after the destination is seen verified (GET /mail/forward or the cron sweep) AND the
// user's switch is on does inbound mail delivered TO THAT USER get forwarded.
//
// Ownership must be proven by THIS registration: a destination that already exists in the
// account (verified by someone else, earlier) is deleted and re-created so a fresh
// verification mail goes out — unless it is in use (an Email Routing forward rule or the
// archive forward target), in which case the registration is refused (409).
//
// Scope = the ENVELOPE recipient's own mail only (same rule as gmail-forward.ts): mail a
// user can merely see through role sharing / mail:read_all is never forwarded to them.
// The inbound forward NEVER throws and runs after storage, so it can't lose or block a mail.
import { DubError } from "@dub/errors";
import type { DbClient } from "@dub/db";
import { nowIso } from "@dub/db";
import type { Fetcher } from "@cloudflare/workers-types";
import { publishAudit } from "@dub/events";
import type { RequestContext } from "@dub/http";
import { consoleSink } from "@dub/observability";
import { mail } from "@dub/types";
import { SERVICE_NAME } from "./config";
import { CfEmailRoutingClient, emailRoutingConfigFromEnv, requireEmailRoutingConfig } from "./email-routing";
import type { Env } from "./env";
import { FORWARDED_HEADER, maskEmail, type ForwardOutcome, type MailForwarder } from "./gmail-forward";
import { parseAddress, type RawInbound } from "./mime";
import { lookupRosterUserId } from "./owner";
import type { AuditEnv } from "./types";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Minimum gap between two registrations of one account (each one sends a verification mail). */
export const REGISTER_COOLDOWN_MS = 60_000;
/** Pending rows the cron sweep checks per tick (bounded subrequests on the free plan). */
export const SWEEP_LIMIT = 10;
/** A pending registration older than this is no longer polled by the sweep. */
const SWEEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface ForwardRow {
  owner_user_id: string;
  target: string;
  cf_address_id: string | null;
  enabled: number;
  requested_at: string;
  verified_at: string | null;
  last_result: "forwarded" | "failed" | null;
  last_error: string | null;
  last_at: string | null;
  register_day: string | null;
  register_count: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const lower = (v: string | null | undefined): string => (v ?? "").trim().toLowerCase();

/** "off" switches the whole feature off (inbound + registration). Default: available. */
export function userForwardDisabled(env: Pick<Env, "MAIL_USER_FORWARD">): boolean {
  return lower(env.MAIL_USER_FORWARD) === "off";
}

/** Registration needs the Email Routing token + account id (destinations are account-scoped). */
export function userForwardAvailable(env: Env): boolean {
  const cfg = emailRoutingConfigFromEnv(env);
  return !userForwardDisabled(env) && !!cfg && !!cfg.accountId;
}

/** Strip anything that looks like an address and cap the length (stored + shown in the UI). */
export function scrubError(msg: string): string {
  return msg.replace(/[^\s@<>"']+@[^\s@<>"']+/g, "(address)").slice(0, 200);
}

function toSetting(row: ForwardRow | null, available: boolean): mail.MailForwardSetting {
  if (!row) {
    return { target: null, status: "none", enabled: false, active: false, available, requestedAt: null, verifiedAt: null, lastResult: null, lastError: null, lastAt: null };
  }
  const verified = row.verified_at !== null;
  const enabled = row.enabled === 1;
  return {
    target: row.target,
    status: verified ? "verified" : "pending",
    enabled,
    active: enabled && verified && available,
    available,
    requestedAt: row.requested_at,
    verifiedAt: row.verified_at,
    lastResult: row.last_result,
    lastError: row.last_error,
    lastAt: row.last_at,
  };
}

async function liveRow(db: DbClient, owner: string): Promise<ForwardRow | null> {
  return (await db.first<ForwardRow>(`SELECT * FROM mail_user_forward WHERE owner_user_id = ? AND deleted_at IS NULL`, owner)) ?? null;
}

// ---- validation ----

export function parseRegisterRequest(body: unknown): mail.MailForwardRegisterRequest {
  const value = body !== null && typeof body === "object" ? (body as { target?: unknown }).target : undefined;
  const target = typeof value === "string" ? lower(value) : "";
  if (!EMAIL_RE.test(target) || target.length > 254) {
    throw new DubError("MAIL_INVALID_REQUEST", "target must be a valid email address", { status: 400 });
  }
  return { target };
}

export function parseForwardPatch(body: unknown): mail.MailForwardPatch {
  if (body === null || typeof body !== "object" || typeof (body as { enabled?: unknown }).enabled !== "boolean") {
    throw new DubError("MAIL_INVALID_REQUEST", "enabled (boolean) required", { status: 400 });
  }
  return { enabled: (body as { enabled: boolean }).enabled };
}

/** Targets that can never be a personal forward destination. */
export function assertTargetAllowed(env: Env, target: string, ownAddress: string | null): void {
  const zone = lower(env.CF_EMAIL_ROUTING_ZONE_NAME) || "developershub.jp";
  const domain = target.slice(target.lastIndexOf("@") + 1);
  // A target on our own zone would loop straight back into this Worker.
  if (domain === zone || domain.endsWith(`.${zone}`)) {
    throw new DubError("MAIL_INVALID_REQUEST", `a ${zone} address cannot be a forward target`, { status: 400 });
  }
  if (ownAddress && target === lower(ownAddress)) {
    throw new DubError("MAIL_INVALID_REQUEST", "cannot forward to your own Dub address", { status: 400 });
  }
  if (target === lower(env.MAIL_ARCHIVE_FORWARD_TO)) {
    throw new DubError("MAIL_FORWARD_TARGET_IN_USE", "this address is used by the organization archive", { status: 409 });
  }
}

// ---- read / refresh ----

/** Re-check a pending row against Cloudflare; stamps verified_at when it flipped. Best-effort. */
async function refreshVerification(db: DbClient, env: Env, row: ForwardRow): Promise<ForwardRow> {
  if (row.verified_at || !row.cf_address_id) return row;
  const cfg = emailRoutingConfigFromEnv(env);
  if (!cfg?.accountId) return row;
  try {
    const addr = await new CfEmailRoutingClient(cfg).getAddress(row.cf_address_id);
    if (!addr?.verified || lower(addr.email) !== row.target) return row;
    const now = nowIso();
    await db.run(
      `UPDATE mail_user_forward SET verified_at = ?, updated_at = ? WHERE owner_user_id = ? AND cf_address_id = ? AND deleted_at IS NULL`,
      now,
      now,
      row.owner_user_id,
      row.cf_address_id,
    );
    return { ...row, verified_at: now, updated_at: now };
  } catch {
    return row; // Cloudflare unreachable / address deleted: stays pending
  }
}

export async function getForwardSetting(db: DbClient, env: Env, owner: string): Promise<mail.MailForwardSetting> {
  const row = await liveRow(db, owner);
  return toSetting(row ? await refreshVerification(db, env, row) : null, userForwardAvailable(env));
}

/** Cron: verify a few pending registrations so forwarding starts even if the user never
 *  comes back to the settings screen after clicking the link. Never throws. */
export async function sweepPendingForwards(db: DbClient, env: Env, now = Date.now()): Promise<number> {
  if (!userForwardAvailable(env)) return 0;
  try {
    const since = new Date(now - SWEEP_MAX_AGE_MS).toISOString();
    const rows = await db.all<ForwardRow>(
      `SELECT * FROM mail_user_forward WHERE verified_at IS NULL AND deleted_at IS NULL AND enabled = 1 AND cf_address_id IS NOT NULL AND requested_at >= ? ORDER BY requested_at DESC LIMIT ?`,
      since,
      SWEEP_LIMIT,
    );
    let verified = 0;
    for (const r of rows) if ((await refreshVerification(db, env, r)).verified_at) verified++;
    return verified;
  } catch (err) {
    consoleSink({ level: "error", message: "mail-gateway: user forward sweep failed", service: SERVICE_NAME, fields: { error: err instanceof Error ? err.message : String(err) } });
    return 0;
  }
}

// ---- mutations ----

/**
 * Register (or change / re-send verification for) the caller's personal address. Creates a
 * fresh Cloudflare destination address so Cloudflare mails the verification link to it.
 */
export async function registerForwardTarget(
  db: DbClient,
  env: Env,
  owner: string,
  target: string,
  now = new Date(),
): Promise<mail.MailForwardSetting> {
  if (userForwardDisabled(env)) {
    throw new DubError("MAIL_FORWARD_DISABLED", "auto-forward is switched off on this server", { status: 503 });
  }
  const client = new CfEmailRoutingClient(requireEmailRoutingConfig(env));

  const prev = await db.first<ForwardRow>(`SELECT * FROM mail_user_forward WHERE owner_user_id = ?`, owner);
  const day = now.toISOString().slice(0, 10);
  const prevLive = prev && prev.deleted_at === null ? prev : null;
  if (prevLive && now.getTime() - Date.parse(prevLive.requested_at) < REGISTER_COOLDOWN_MS) {
    throw new DubError("MAIL_FORWARD_RATE_LIMITED", "please wait a minute before sending another verification mail", { status: 429, retryable: true });
  }
  const count = prev?.register_day === day ? prev.register_count : 0;
  if (count >= mail.MAIL_FORWARD_DAILY_REGISTER_LIMIT) {
    throw new DubError("MAIL_FORWARD_RATE_LIMITED", `at most ${mail.MAIL_FORWARD_DAILY_REGISTER_LIMIT} verification mails per day`, { status: 429, retryable: true });
  }
  const taken = await db.first<{ owner_user_id: string }>(
    `SELECT owner_user_id FROM mail_user_forward WHERE target = ? AND deleted_at IS NULL AND owner_user_id <> ?`,
    target,
    owner,
  );
  if (taken) throw new DubError("MAIL_FORWARD_TARGET_IN_USE", "this address is already registered by another account", { status: 409 });

  // Ownership must be proven by THIS registration: replace any existing destination.
  const existing = (await client.listAllAddresses()).find((a) => lower(a.email) === target);
  if (existing) {
    if (existing.verified) {
      const rules = await client.listRules();
      const inUse = rules.some((r) => r.actions?.some((a) => a.type === "forward" && a.value?.some((v) => lower(v) === target)));
      if (inUse) throw new DubError("MAIL_FORWARD_TARGET_IN_USE", "this address is used by an Email Routing rule; ask an administrator", { status: 409 });
    }
    await client.deleteAddress(existing.id);
  }
  const created = await client.createAddress(target);

  const ts = now.toISOString();
  try {
    await db.run(
      `INSERT INTO mail_user_forward (owner_user_id, target, cf_address_id, enabled, requested_at, verified_at, last_result, last_error, last_at, register_day, register_count, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, 1, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, NULL)
       ON CONFLICT(owner_user_id) DO UPDATE SET target = excluded.target, cf_address_id = excluded.cf_address_id, enabled = 1,
         requested_at = excluded.requested_at, verified_at = NULL, last_result = NULL, last_error = NULL, last_at = NULL,
         register_day = excluded.register_day, register_count = excluded.register_count, updated_at = excluded.updated_at, deleted_at = NULL`,
      owner,
      target,
      created?.id ?? null,
      ts,
      day,
      count + 1,
      ts,
      ts,
    );
  } catch (err) {
    if (/UNIQUE/i.test(err instanceof Error ? err.message : String(err))) {
      throw new DubError("MAIL_FORWARD_TARGET_IN_USE", "this address is already registered by another account", { status: 409 });
    }
    throw err;
  }
  return toSetting(await liveRow(db, owner), userForwardAvailable(env));
}

export async function setForwardEnabled(db: DbClient, env: Env, owner: string, enabled: boolean): Promise<mail.MailForwardSetting> {
  const res = await db.run(
    `UPDATE mail_user_forward SET enabled = ?, updated_at = ? WHERE owner_user_id = ? AND deleted_at IS NULL`,
    enabled ? 1 : 0,
    nowIso(),
    owner,
  );
  if (res.meta.changes === 0) throw new DubError("MAIL_FORWARD_NOT_FOUND", "no forward address registered", { status: 404 });
  return getForwardSetting(db, env, owner);
}

/** Stop + forget the address (soft delete; the Cloudflare destination is left in place —
 *  a later claim by anyone re-creates it and re-verifies). */
export async function removeForwardSetting(db: DbClient, env: Env, owner: string): Promise<mail.MailForwardSetting> {
  const now = nowIso();
  const res = await db.run(
    `UPDATE mail_user_forward SET deleted_at = ?, enabled = 0, updated_at = ? WHERE owner_user_id = ? AND deleted_at IS NULL`,
    now,
    now,
    owner,
  );
  if (res.meta.changes === 0) throw new DubError("MAIL_FORWARD_NOT_FOUND", "no forward address registered", { status: 404 });
  return toSetting(null, userForwardAvailable(env));
}

// ---- inbound ----

export interface UserForwardDeps {
  db: DbClient;
  identity?: Fetcher;
  audit: AuditEnv;
  orgId: string;
  ctx: RequestContext;
  archiveAddress?: string | null;
  internalDomain: string;
  disabled: boolean;
}

/** The value stamped in FORWARDED_HEADER on a per-user copy. */
export const USER_FORWARD_MARK = "user";

/**
 * Forward `raw` to the envelope recipient's verified opt-in address. NEVER throws. Returns
 * `skipped/no_setting` when the recipient has no registration at all (the legacy 名簿 Gmail
 * forward may then run); any registration — even switched off — suppresses that fallback.
 */
export async function forwardToUserTarget(deps: UserForwardDeps, message: MailForwarder, raw: RawInbound): Promise<ForwardOutcome> {
  let outcome: ForwardOutcome;
  let row: ForwardRow | null = null;
  try {
    const decided = await decide(deps, raw);
    row = decided.row;
    outcome = decided.outcome ?? (await doForward(message, decided.row!));
  } catch (err) {
    outcome = { status: "skipped", reason: `lookup_error: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (row && outcome.status !== "skipped") await recordOutcome(deps, row, outcome);
  return outcome;
}

async function decide(deps: UserForwardDeps, raw: RawInbound): Promise<{ row: ForwardRow | null; outcome?: ForwardOutcome }> {
  if (deps.disabled) return { row: null, outcome: { status: "skipped", reason: "disabled" } };
  if (raw.headers[FORWARDED_HEADER.toLowerCase()] !== undefined) return { row: null, outcome: { status: "skipped", reason: "already_forwarded" } };
  const recipient = lower(parseAddress(raw.to).email);
  if (!recipient) return { row: null, outcome: { status: "skipped", reason: "no_recipient" } };
  if (recipient === lower(deps.archiveAddress)) return { row: null, outcome: { status: "skipped", reason: "archive" } };
  const userId = await lookupRosterUserId(deps.identity, deps.ctx, recipient);
  if (!userId) return { row: null, outcome: { status: "skipped", reason: "no_roster_user" } };
  const row = await liveRow(deps.db, userId);
  if (!row) return { row: null, outcome: { status: "skipped", reason: "no_setting" } };
  if (row.enabled !== 1) return { row: null, outcome: { status: "skipped", reason: "switched_off" } };
  if (!row.verified_at) return { row: null, outcome: { status: "skipped", reason: "unverified" } };
  const zone = lower(deps.internalDomain);
  if (row.target.endsWith(`@${zone}`) || row.target.endsWith(`.${zone}`)) return { row: null, outcome: { status: "skipped", reason: "internal_target" } };
  // Mail the user sent from that address (e.g. a Gmail rule forwarding back to Dub).
  const senders = [lower(parseAddress(raw.from).email), lower(parseAddress(raw.headers["from"] ?? "").email)];
  if (senders.includes(row.target)) return { row: null, outcome: { status: "skipped", reason: "from_target" } };
  return { row };
}

async function doForward(message: MailForwarder, row: ForwardRow): Promise<ForwardOutcome> {
  try {
    await message.forward(row.target, new Headers({ [FORWARDED_HEADER]: USER_FORWARD_MARK }));
    return { status: "forwarded", userId: row.owner_user_id };
  } catch (err) {
    return { status: "failed", userId: row.owner_user_id, reason: scrubError(err instanceof Error ? err.message : String(err)) };
  }
}

async function recordOutcome(deps: UserForwardDeps, row: ForwardRow, outcome: ForwardOutcome): Promise<void> {
  const now = nowIso();
  const failed = outcome.status === "failed";
  consoleSink({
    level: failed ? "error" : "info",
    message: `mail-gateway: user forward ${outcome.status}`,
    service: SERVICE_NAME,
    requestId: deps.ctx.requestId,
    fields: { ...outcome, target: maskEmail(row.target) },
  });
  try {
    await deps.db.run(
      `UPDATE mail_user_forward SET last_result = ?, last_error = ?, last_at = ? WHERE owner_user_id = ? AND deleted_at IS NULL`,
      failed ? "failed" : "forwarded",
      failed ? outcome.reason : null,
      now,
      row.owner_user_id,
    );
  } catch {
    // status line is cosmetic; the console record above already captured the outcome
  }
  try {
    await publishAudit(deps.audit, {
      action: "mail.message.forward_user",
      actorId: null,
      orgId: deps.orgId,
      result: failed ? "failure" : "success",
      resourceType: "user",
      resourceId: row.owner_user_id,
      details: { target: maskEmail(row.target), ...(failed ? { error: outcome.reason } : {}) },
      requestId: deps.ctx.requestId,
      occurredAt: now,
    });
  } catch {
    // audit is best-effort
  }
}
