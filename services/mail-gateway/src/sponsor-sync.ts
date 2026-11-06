// スポンサーのメール連携 (mail-gateway 側)。営業先の進捗は member-service が持つので、ここは
//   1. 人が送ったメール / 受け取ったメールを member-service に知らせる (notifySponsorContact)
//   2. member-service の求めで、登録アドレスとのメールを集計して返す (querySponsorContacts)
// だけを行う。どの営業先か・何を変えるかは member-service (@dub/types sponsor の決まり) が決める。
//
// 知らせるのは best-effort: 失敗してもメールの送受信は失敗させない (ログだけ)。取りこぼしは
// 管理者の一括補完 (member-service → querySponsorContacts) で後から埋まる。決まりが単調なので二重に届いても同じ。
// 件名・本文は渡さない (アドレスと日時だけ)。
import type { Fetcher } from "@cloudflare/workers-types";
import type { DbClient } from "@dub/db";
import { createServiceClient, type RequestContext } from "@dub/http";
import { consoleSink } from "@dub/observability";
import { sponsor } from "@dub/types";
import { SERVICE_NAME } from "./config";

export interface SponsorSyncPort {
  notify(ctx: RequestContext, notice: sponsor.MailActivityNotice): Promise<void>;
}

const NOTIFY_PATH = "/members/internal/sponsor/mail-activity";

/** member-service への通知 (POST なので再試行しない = subrequest 1 つ)。 */
export function sponsorSyncVia(member: Fetcher): SponsorSyncPort {
  const client = createServiceClient(member, { service: "member-service", caller: SERVICE_NAME, timeoutMs: 5_000 });
  return {
    async notify(ctx, notice) {
      // system origin: 送った本人の権限は関係ない (INTERNAL ルート)。
      await client.post<sponsor.MailActivityResult, sponsor.MailActivityNotice>({ requestId: ctx.requestId, caller: SERVICE_NAME }, NOTIFY_PATH, notice);
    },
  };
}

/** MAIL_SPONSOR_SYNC="off" で止められる (既定は on)。 */
export function sponsorSyncDisabled(flag: string | undefined): boolean {
  return flag?.trim().toLowerCase() === "off";
}

/** 社外の相手だけ残す (自社ドメイン・アーカイブを除き、重複なし・小文字)。 */
export function externalCounterparts(addresses: readonly (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const raw of addresses) {
    const a = sponsor.normalizeAddress(raw);
    if (a && !sponsor.OWN_MAIL_DOMAINS.includes(sponsor.mailDomain(a))) out.add(a);
  }
  return [...out];
}

/** 送受信の通知。相手が社外にいなければ呼ばない。決して throw しない。 */
export async function notifySponsorContact(
  port: SponsorSyncPort | undefined,
  ctx: RequestContext,
  notice: Omit<sponsor.MailActivityNotice, "counterparts"> & { counterparts: readonly (string | null | undefined)[] },
): Promise<void> {
  if (!port) return;
  const counterparts = externalCounterparts(notice.counterparts);
  if (counterparts.length === 0) return;
  try {
    await port.notify(ctx, { ...notice, counterparts });
  } catch (err) {
    consoleSink({
      level: "warn",
      message: "mail-gateway: sponsor mail sync notify failed (backfill will catch up)",
      service: SERVICE_NAME,
      requestId: ctx.requestId,
      fields: { direction: notice.direction, error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/** 自動応答 (不在通知など) は「返信あり」にしない。 */
export function isAutoReply(autoSubmitted: string | null | undefined, loopMarker: string | null | undefined): boolean {
  const v = autoSubmitted?.trim().toLowerCase();
  return Boolean(loopMarker) || (Boolean(v) && v !== "no");
}

const ADDRESS_FILTER = `address IN (SELECT value FROM json_each(?))`;

// 人が送った (owner あり) 送信済みメールの To / Cc。日時は送信を受け付けた時刻。
const SENT_SQL = `SELECT address, min(at) AS first_at, max(at) AS last_at, count(*) AS n FROM (
    SELECT lower(trim(json_extract(r.value, '$.email'))) AS address, s.created_at AS at
      FROM mail_send_log s, json_each(s.to_json) r
      WHERE s.status = 'sent' AND s.deleted_at IS NULL AND s.owner_user_id IS NOT NULL
    UNION ALL
    SELECT lower(trim(json_extract(r.value, '$.email'))) AS address, s.created_at AS at
      FROM mail_send_log s, json_each(coalesce(s.cc_json, '[]')) r
      WHERE s.status = 'sent' AND s.deleted_at IS NULL AND s.owner_user_id IS NOT NULL
  ) WHERE ${ADDRESS_FILTER} GROUP BY address`;

// 受け取ったメールの From (自動応答・ループを除く)。日時は Dub が受け取った時刻 (差出人の Date ヘッダは信用しない)。
const RECEIVED_SQL = `SELECT address, min(at) AS first_at, max(at) AS last_at, count(*) AS n FROM (
    SELECT lower(trim(json_extract(from_json, '$.email'))) AS address, created_at AS at
      FROM mail_inbound
      WHERE deleted_at IS NULL AND loop_marker IS NULL AND (auto_submitted IS NULL OR lower(trim(auto_submitted)) = 'no')
  ) WHERE ${ADDRESS_FILTER} GROUP BY address`;

interface AggRow {
  address: string;
  first_at: string;
  last_at: string;
  n: number;
}

/** 指定アドレスとのメールを、相手アドレス × 方向ごとに集計する (D1 の読み取り 2 回)。 */
export async function querySponsorContacts(db: DbClient, q: sponsor.MailContactsQuery): Promise<sponsor.MailContactSummary[]> {
  const addresses = JSON.stringify(q.addresses);
  const [sent, received] = await Promise.all([db.all<AggRow>(SENT_SQL, addresses), db.all<AggRow>(RECEIVED_SQL, addresses)]);
  const to = (direction: sponsor.MailDirection) => (r: AggRow): sponsor.MailContactSummary => ({
    address: r.address,
    direction,
    firstAt: r.first_at,
    lastAt: r.last_at,
    count: Number(r.n),
  });
  return [...sent.map(to("sent")), ...received.map(to("received"))];
}

/** POST /internal/sponsor/contacts の入力検証 (小文字・重複なし・上限)。 */
export function parseContactsQuery(body: unknown): sponsor.MailContactsQuery | null {
  const b = (body ?? {}) as { addresses?: unknown };
  if (!Array.isArray(b.addresses)) return null;
  const addresses = [...new Set(b.addresses.filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase()).filter(Boolean))];
  if (addresses.length > sponsor.MAIL_CONTACTS_QUERY_MAX) return null;
  return { addresses };
}
