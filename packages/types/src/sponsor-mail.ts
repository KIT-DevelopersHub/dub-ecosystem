// sponsor (メール連携) — Dub のメールで営業先とやり取りしたら、営業進捗の日付とステータスを自動で進める。
// 照合 (どの営業先宛てのメールか) と更新の決まり (何をどう変えるか) はここ 1 か所に置き、
// member-service (本番) と fe2 の demo が同じ関数を使う。sponsor.ts から再エクスポートされる。
//
// 数えるのは「登録したアドレス」とのメールだけ。推測 (同じドメインの別の人など) では数えない:
//   1. 営業先の担当者メール欄にあるアドレス
//   2. 名刺に登録したメールアドレス (名刺の会社名の照合キー companyKey が同じ営業先のもの)
import type { ISODateTime, UserId } from "./common";
import type { LeadFields, LeadStatus, SponsorLead } from "./sponsor";
import { companyKey } from "./sponsor-company";

// ── 照合 ──────────────────────────────────────────────────

/** こちら側 (Dub) のドメイン。社内のやり取りは営業先との接触ではない。 */
export const OWN_MAIL_DOMAINS: readonly string[] = ["developershub.jp"];

const ADDRESS_RE = /[^\s<>()（）「」,，、;；／/:："'`]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;

/** 1 つのアドレスを小文字に揃える。アドレスとして読めなければ null。 */
export function normalizeAddress(value: string | null | undefined): string | null {
  const m = (value ?? "").normalize("NFKC").trim().toLowerCase().match(ADDRESS_RE);
  return m && m.length === 1 ? m[0]! : null;
}

/** 担当者メール欄 (「a／b（CC）」「a, b」など) からアドレスを全部取り出す (重複なし・小文字)。 */
export function parseContactEmails(value: string | null | undefined): string[] {
  const found = (value ?? "").normalize("NFKC").toLowerCase().match(ADDRESS_RE) ?? [];
  return [...new Set(found)];
}

export function mailDomain(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/** 社外のアドレスか (自社ドメインは営業先との接触ではない)。 */
export function isExternalAddress(address: string): boolean {
  return !OWN_MAIL_DOMAINS.includes(mailDomain(address));
}

/** どこに登録されたアドレスで営業先と結び付いたか。contact = 担当者メール / card = 名刺。 */
export type MailMatchBy = "contact" | "card";

export interface LeadMatch {
  leadId: string;
  by: MailMatchBy;
}

/** 照合に使う営業先 (論理削除済みは渡さない)。 */
export type MatchableLead = Pick<LeadFields, "contactEmail" | "companyName"> & { id: string };

/** 照合に使う名刺 (論理削除済みは渡さない)。 */
export interface MatchableCard {
  email: string | null;
  companyName: string | null;
}

/** 営業先ごとの登録アドレス (担当者メール + 同じ会社の名刺のメール)。画面の説明にも使う。 */
export function registeredAddresses(lead: MatchableLead, cards: readonly MatchableCard[]): { address: string; by: MailMatchBy }[] {
  const out = new Map<string, MailMatchBy>();
  for (const a of parseContactEmails(lead.contactEmail)) if (isExternalAddress(a)) out.set(a, "contact");
  const key = companyKey(lead.companyName);
  for (const c of cards) {
    if (!c.companyName || companyKey(c.companyName) !== key) continue;
    for (const a of parseContactEmails(c.email)) if (isExternalAddress(a) && !out.has(a)) out.set(a, "card");
  }
  return [...out].map(([address, by]) => ({ address, by }));
}

/**
 * 相手のアドレス → 営業先。登録したアドレス (担当者メール・名刺のメール) と完全に一致した時だけ。
 * 同じアドレスが 2 社以上に登録されている (曖昧な) ときは更新しないので null。
 */
export function buildLeadMatcher(leads: readonly MatchableLead[], cards: readonly MatchableCard[]): (address: string) => LeadMatch | null {
  const byAddress = new Map<string, Map<string, MailMatchBy>>();
  for (const l of leads) {
    for (const { address, by } of registeredAddresses(l, cards)) {
      const owners = byAddress.get(address) ?? new Map<string, MailMatchBy>();
      if (!owners.has(l.id)) owners.set(l.id, by);
      byAddress.set(address, owners);
    }
  }
  return (raw) => {
    const address = normalizeAddress(raw);
    const owners = address ? byAddress.get(address) : undefined;
    if (!owners || owners.size !== 1) return null;
    const [leadId, by] = [...owners][0]!;
    return { leadId, by };
  };
}

// ── 更新の決まり ──────────────────────────────────────────

export type MailDirection = "sent" | "received";

/** 1 通のメール (日付は日本時間の暦日 YYYY-MM-DD)。 */
export interface MailContact {
  direction: MailDirection;
  on: string;
}

/** メールで変わりうる項目。 */
export type MailSyncFields = Pick<LeadFields, "status" | "firstContactOn" | "lastContactOn">;
export type MailSyncField = keyof MailSyncFields;

export interface LeadFieldChange {
  field: MailSyncField;
  from: string | null;
  to: string | null;
}

const minOn = (cur: string | null, on: string): string => (cur === null || on < cur ? on : cur);
const maxOn = (cur: string | null, on: string): string => (cur === null || on > cur ? on : cur);

/**
 * 1 通ぶんの更新。
 * - 送信: 初回連絡日 = より早い方 / 最終接触日 = より遅い方 / 未接触 → 初回連絡。
 * - 受信: 最終接触日 = より遅い方 / 初回連絡 → 返信あり。
 * ステータスは前にしか進めず、上の 2 つ以外 (見送りを含む) は触らない。
 * 未接触 → 初回連絡 は applyLeadMilestones と同じ結果になる (初回連絡日をメールの日付で明示するので「今日」は入らない)。
 */
export function applyMailContact<T extends MailSyncFields>(lead: T, c: MailContact): T {
  if (c.direction === "sent") {
    const status: LeadStatus = lead.status === "未接触" ? "初回連絡" : lead.status;
    return { ...lead, status, firstContactOn: minOn(lead.firstContactOn, c.on), lastContactOn: maxOn(lead.lastContactOn, c.on) };
  }
  const status: LeadStatus = lead.status === "初回連絡" ? "返信あり" : lead.status;
  return { ...lead, status, lastContactOn: maxOn(lead.lastContactOn, c.on) };
}

/** 複数のメールを古い順 (同じ日は送信が先) に当てる。何も変わらなければ changes は空。 */
export function applyMailContacts<T extends MailSyncFields>(lead: T, contacts: readonly MailContact[]): { next: T; changes: LeadFieldChange[] } {
  const ordered = [...contacts].sort((a, b) => a.on.localeCompare(b.on) || (a.direction === b.direction ? 0 : a.direction === "sent" ? -1 : 1));
  const next = ordered.reduce(applyMailContact, lead);
  const fields: MailSyncField[] = ["status", "firstContactOn", "lastContactOn"];
  const changes = fields.filter((f) => next[f] !== lead[f]).map((f) => ({ field: f, from: lead[f], to: next[f] }));
  return { next, changes };
}

// ── wire 契約 ─────────────────────────────────────────────

/** メール画面から、相手のアドレスを営業先の担当者メールに登録する (以後このアドレスとのメールを数える)。 */
export interface RegisterContactEmailRequest {
  address: string;
}

export interface RegisterContactEmailResponse {
  /** 登録後の営業先 (担当者メールへの追加・既存メールからの更新を反映済み)。 */
  lead: SponsorLead;
}

/** 自動更新の由来。live = 送受信した時 / register = アドレスを登録した時に既存メールから / backfill = 管理者の一括補完。 */
export type MailSyncSource = "live" | "register" | "backfill";

/** 営業先の履歴 1 件 (メールからの自動更新)。件名・本文は持たない (メールの持ち主以外にも見えるため)。 */
export interface LeadActivity {
  id: string;
  leadId: string;
  source: MailSyncSource;
  direction: MailDirection;
  /** 根拠のメールの日時。 */
  mailAt: ISODateTime;
  /** 相手 (営業先側) のアドレス。 */
  counterpart: string;
  matchedBy: MailMatchBy;
  /** こちら側のアドレス (送信元 / 受信した Dub のアドレス)。分からなければ null。 */
  mailbox: string | null;
  changes: LeadFieldChange[];
  createdAt: ISODateTime;
}

export interface ListLeadActivityResponse {
  activity: LeadActivity[];
}

export const MAIL_BACKFILL_DEFAULT_LIMIT = 50;
export const MAIL_BACKFILL_MAX_LIMIT = 100;

/** 既存メールからの一括補完。営業先を offset から limit 社ずつ見る (Workers の 1 回あたりの外部呼び出し上限に収めるため)。 */
export interface MailBackfillRequest {
  dryRun: boolean;
  offset?: number;
  limit?: number;
}

/** 1 社ぶんの提案 (dryRun) / 結果。 */
export interface MailBackfillProposal {
  leadId: string;
  companyName: string;
  matchedBy: MailMatchBy;
  changes: LeadFieldChange[];
  /** 根拠のメール (相手ごとの最初と最後)。 */
  evidence: { direction: MailDirection; at: ISODateTime; counterpart: string }[];
  /** dryRun でない時: 保存できたか (他の人の編集と 3 回ぶつかったら false)。 */
  applied?: boolean;
}

export interface MailBackfillResponse {
  dryRun: boolean;
  offset: number;
  limit: number;
  /** 営業先の総数 (ページ送りの目安)。 */
  total: number;
  /** 次のページの offset。最後なら null。 */
  nextOffset: number | null;
  proposals: MailBackfillProposal[];
}

// ── サービス間 (外からは呼べない) ──────────────────────────

/** mail-gateway → member-service: Dub のメールを送った / 受け取った。 */
export interface MailActivityNotice {
  direction: MailDirection;
  at: ISODateTime;
  /** 相手のアドレス (送信 = To + Cc / 受信 = From)。 */
  counterparts: string[];
  /** こちら側のアドレス。 */
  mailbox: string | null;
}

export interface MailActivityResult {
  updated: number;
}

/** member-service → mail-gateway: このアドレスとのメールの集計をください。 */
export interface MailContactsQuery {
  addresses: string[];
}

/** 相手 1 アドレス × 方向ごとの集計 (送信は人が送ったもの、受信は自動応答を除く)。 */
export interface MailContactSummary {
  address: string;
  direction: MailDirection;
  firstAt: ISODateTime;
  lastAt: ISODateTime;
  count: number;
}

export interface MailContactsResponse {
  contacts: MailContactSummary[];
}

/** 1 回の集計で受け付ける件数の上限 (SQL の IN が長くなりすぎないように)。 */
export const MAIL_CONTACTS_QUERY_MAX = 300;
