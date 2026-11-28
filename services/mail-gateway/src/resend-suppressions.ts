// Resend の送信停止リスト（Suppressions）を見る・戻す。
//
// Why: Resend はハードバウンスした宛先を Suppressions に入れ、以後その宛先への送信を
// 黙って捨てる（送信 API は 200 のまま）。発行直後の @zone アドレスは Email Routing の
// ルールが行き渡る前に確認メール / アカウント発行メールの Cc を受けてバウンスし、
// 届くようになった後も Dub から送ったメールだけが永久に届かなくなっていた（#898 の
// canary で dev-monitor@ が To 未着になった原因）。
//
//   - 管理者の経路: GET/DELETE /mail/admin/email-routing/suppressions（mail:admin）
//   - 自動の戻し: cron の sweepSuppressions。自ゾーンのアドレスで、今は受信ルールが
//     有効なもの（= バウンスの原因が解消済み）だけを外す。同じアドレスは 7 日に 1 回まで
//     （本当に届かない宛先で外す→再バウンスを繰り返さない）。記録は mail_provider_event。
//
// Resend の Suppressions API: GET /suppressions, GET|DELETE /suppressions/{id|email}。
// アカウントで使えない（401/403/404 on list）時は MAIL_SUPPRESSIONS_UNAVAILABLE（503）。
import { DubError } from "@dub/errors";
import { nowIso } from "@dub/db";
import type { DbClient } from "@dub/db";
import type { Env } from "./env";
import { CfEmailRoutingClient, emailRoutingConfigFromEnv, issuedAddressesFromRules } from "./email-routing";
import { isInternalAddress } from "./resend-webhook";

const RESEND_API = "https://api.resend.com";
const DEFAULT_ZONE = "developershub.jp";
export const SUPPRESSION_MAX_PAGES = 10;
/** 外したばかりの suppression はまだ新しいバウンスの可能性がある: これより古いものだけ自動で外す。 */
export const AUTOHEAL_MIN_AGE_MS = 15 * 60 * 1000;
/** 同じアドレスを自動で外すのは 7 日に 1 回まで。 */
export const AUTOHEAL_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
export const AUTOHEAL_EVENT = "dub.suppression_removed";

export interface Suppression {
  id: string;
  email: string;
  origin: string; // bounce | complaint | manual
  sourceId: string | null; // the Resend email id that triggered it
  createdAt: string;
}

interface RawSuppression {
  id?: string;
  email?: string;
  origin?: string;
  source_id?: string | null;
  created_at?: string;
}

function toSuppression(r: RawSuppression): Suppression | null {
  if (typeof r?.id !== "string" || typeof r.email !== "string") return null;
  return {
    id: r.id,
    email: r.email.trim().toLowerCase(),
    origin: r.origin ?? "unknown",
    sourceId: r.source_id ?? null,
    createdAt: r.created_at ?? "",
  };
}

function unavailable(status: number): DubError {
  return new DubError("MAIL_SUPPRESSIONS_UNAVAILABLE", `Resend Suppressions API is not available for this account (${status})`, {
    status: 503,
    retryable: false,
  });
}

function upstream(status: number): DubError {
  return new DubError("MAIL_PROVIDER_UNAVAILABLE", `Resend Suppressions API failed (${status})`, { status: 502, retryable: status >= 500 });
}

export class ResendSuppressionsClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly apiKey: string,
    fetchImpl?: typeof fetch,
    private readonly timeoutMs = 10_000,
  ) {
    // Bound: `this.fetchImpl(...)` with a bare global fetch runs with `this === client`, which
    // Workers rejects ("Illegal invocation") — every sweep failed that way in prod (2026-11-28).
    this.fetchImpl = fetchImpl ?? fetch.bind(globalThis);
  }

  private async call(method: string, path: string): Promise<Response> {
    try {
      return await this.fetchImpl(`${RESEND_API}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      throw new DubError("MAIL_PROVIDER_UNAVAILABLE", `Resend Suppressions request failed (${detail})`, { status: 502, cause: err, retryable: true });
    }
  }

  /** All suppressions (bounded by SUPPRESSION_MAX_PAGES × 100). */
  async list(): Promise<Suppression[]> {
    const out: Suppression[] = [];
    let after: string | null = null;
    for (let page = 0; page < SUPPRESSION_MAX_PAGES; page++) {
      const q: string = `?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`;
      const res = await this.call("GET", `/suppressions${q}`);
      if (res.status === 401 || res.status === 403 || res.status === 404) throw unavailable(res.status);
      if (!res.ok) throw upstream(res.status);
      const body = (await res.json().catch(() => null)) as { data?: RawSuppression[]; has_more?: boolean } | null;
      const rows = (body?.data ?? []).map(toSuppression).filter((s): s is Suppression => s !== null);
      out.push(...rows);
      if (!body?.has_more || rows.length === 0) break;
      after = rows[rows.length - 1]!.id;
    }
    return out;
  }

  /** One address; null when it is not suppressed. */
  async get(email: string): Promise<Suppression | null> {
    const res = await this.call("GET", `/suppressions/${encodeURIComponent(email)}`);
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) throw unavailable(res.status);
    if (!res.ok) throw upstream(res.status);
    return toSuppression((await res.json().catch(() => null)) as RawSuppression);
  }

  /** Remove by address. false when it was not suppressed. */
  async remove(email: string): Promise<boolean> {
    const res = await this.call("DELETE", `/suppressions/${encodeURIComponent(email)}`);
    if (res.status === 404) return false;
    if (res.status === 401 || res.status === 403) throw unavailable(res.status);
    if (!res.ok) throw upstream(res.status);
    return true;
  }
}

/** Null unless the outbound provider is Resend with a key (other providers have no such list). */
export function suppressionsClientFromEnv(env: Env, fetchImpl?: typeof fetch): ResendSuppressionsClient | null {
  const provider = (env.MAIL_OUTBOUND_PROVIDER ?? "resend").toLowerCase();
  const key = env.RESEND_API_KEY;
  if (provider !== "resend" || typeof key !== "string" || !key) return null;
  return new ResendSuppressionsClient(key, fetchImpl);
}

export function requireSuppressionsClient(env: Env): ResendSuppressionsClient {
  const client = suppressionsClientFromEnv(env);
  if (!client) {
    throw new DubError("MAIL_SUPPRESSIONS_UNAVAILABLE", "Resend is not the configured provider (or RESEND_API_KEY is unset)", { status: 503 });
  }
  return client;
}

export interface SuppressionView extends Suppression {
  /** 自ゾーン（@developershub.jp など）のアドレス。 */
  internal: boolean;
  /** 今 Email Routing の受信ルールがあり有効（= バウンスの原因は解消済みのはず）。null = 確認できない。 */
  receivingRuleEnabled: boolean | null;
}

/** Set of own-zone addresses with an ENABLED receiving rule; null when Email Routing is not configured. */
export async function enabledReceivingAddresses(env: Env): Promise<Set<string> | null> {
  const cfg = emailRoutingConfigFromEnv(env);
  if (!cfg) return null;
  const rules = await new CfEmailRoutingClient(cfg).listRules();
  return new Set(issuedAddressesFromRules(rules, cfg.zoneName).filter((a) => a.enabled).map((a) => a.address.toLowerCase()));
}

export function annotate(list: Suppression[], zone: string, enabled: Set<string> | null): SuppressionView[] {
  return list
    .map((s) => {
      const internal = isInternalAddress(s.email, zone);
      return { ...s, internal, receivingRuleEnabled: internal && enabled ? enabled.has(s.email) : null };
    })
    .sort((a, b) => a.email.localeCompare(b.email));
}

export function zoneOf(env: Env): string {
  return (env.CF_EMAIL_ROUTING_ZONE_NAME || DEFAULT_ZONE).trim();
}

// ---------------------------------------------------------------- auto-heal (cron)

export interface SweepResult {
  enabled: boolean;
  checked: number;
  removed: string[];
  skipped: number;
  error: string | null;
}

export function autohealEnabled(env: Env): boolean {
  return (env.MAIL_SUPPRESSION_AUTOHEAL ?? "").trim().toLowerCase() === "true";
}

/** Which suppressions the sweep may remove: own zone, origin=bounce, the address now has an
 *  enabled receiving rule, older than AUTOHEAL_MIN_AGE_MS, not auto-removed in the cooldown. */
export function pickRemovable(views: SuppressionView[], recentlyRemoved: Set<string>, now: number): SuppressionView[] {
  return views.filter((s) => {
    if (!s.internal || s.receivingRuleEnabled !== true || s.origin !== "bounce") return false;
    if (recentlyRemoved.has(s.email)) return false;
    const created = Date.parse(s.createdAt.replace(" ", "T").replace(/\+00$/, "Z"));
    return !Number.isFinite(created) || now - created >= AUTOHEAL_MIN_AGE_MS;
  });
}

async function recentlyRemoved(db: DbClient, now: number): Promise<Set<string>> {
  const rows = await db.all<{ recipient_key: string }>(
    `SELECT recipient_key FROM mail_provider_event WHERE event_type = ? AND created_at > ?`,
    AUTOHEAL_EVENT,
    new Date(now - AUTOHEAL_COOLDOWN_MS).toISOString(),
  );
  return new Set(rows.map((r) => r.recipient_key));
}

/** Record one removal (doubles as the cooldown marker). */
export async function recordRemoval(db: DbClient, s: Suppression, actor: string, now: number): Promise<void> {
  await db.run(
    `INSERT OR IGNORE INTO mail_provider_event (svix_id, provider, event_type, provider_message_id, send_log_id, recipients_json,
       recipient_key, internal, subject, reason, occurred_at, alerted, created_at)
     VALUES (?, 'resend', ?, ?, NULL, ?, ?, 1, NULL, ?, ?, 1, ?)`,
    `dub-unsuppress:${s.id}`,
    AUTOHEAL_EVENT,
    s.sourceId,
    JSON.stringify([s.email]),
    s.email,
    `removed by ${actor} (origin=${s.origin}, suppressed ${s.createdAt})`,
    new Date(now).toISOString(),
    nowIso(),
  );
}

/** One sweep. Never throws (the cron must keep going). */
export async function sweepSuppressions(env: Env, db: DbClient, now: number = Date.now(), fetchImpl?: typeof fetch): Promise<SweepResult> {
  const out: SweepResult = { enabled: autohealEnabled(env), checked: 0, removed: [], skipped: 0, error: null };
  if (!out.enabled) return out;
  const client = suppressionsClientFromEnv(env, fetchImpl);
  if (!client) return { ...out, error: "resend not configured" };
  try {
    const enabled = await enabledReceivingAddresses(env);
    if (!enabled) return { ...out, error: "email routing not configured" };
    const views = annotate(await client.list(), zoneOf(env), enabled);
    out.checked = views.length;
    const targets = pickRemovable(views, await recentlyRemoved(db, now), now);
    out.skipped = views.length - targets.length;
    for (const s of targets) {
      if (await client.remove(s.email)) {
        await recordRemoval(db, s, "auto-heal", now);
        out.removed.push(s.email);
      }
    }
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  }
  return out;
}

/** "Resend の送信停止リストに登録（bounce・…）" for the canary's To-missing detail; "" when unknown. */
export async function suppressionNote(env: Env, address: string, fetchImpl?: typeof fetch): Promise<string> {
  const client = suppressionsClientFromEnv(env, fetchImpl);
  if (!client) return "";
  try {
    const s = await client.get(address);
    return s ? `・To は Resend の送信停止リストに登録（${s.origin}・${s.createdAt}）` : "";
  } catch {
    return "";
  }
}
