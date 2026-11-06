// sponsor (メール連携) — Dub のメールで営業先とやり取りしたら、営業進捗の日付とステータスを自動で進める。
// 照合 (どの営業先宛てのメールか) と更新の決まり (何をどう変えるか) はここ 1 か所に置き、
// member-service (本番) と fe2 の demo が同じ関数を使う。sponsor.ts から再エクスポートされる。
import type { ISODateTime, UserId } from "./common";
import type { LeadFields, LeadStatus, SponsorLead } from "./sponsor";

// ── 照合 ──────────────────────────────────────────────────

/** 個人向けのフリーメール。同じドメインでも別の会社なので、ドメインでは照合しない。 */
export const FREE_MAIL_DOMAINS: readonly string[] = [
  "gmail.com", "googlemail.com", "yahoo.co.jp", "yahoo.com", "ymail.ne.jp", "outlook.com", "outlook.jp", "hotmail.com",
  "hotmail.co.jp", "live.com", "live.jp", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com",
  "gmx.com", "mail.com", "zoho.com", "yandex.com", "qq.com", "163.com", "naver.com", "nifty.com", "biglobe.ne.jp", "so-net.ne.jp",
  "ocn.ne.jp", "docomo.ne.jp", "ezweb.ne.jp", "au.com", "softbank.ne.jp", "i.softbank.jp", "ymobile.ne.jp", "rakuten.jp",
];

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

/** ドメインで照合してよいか (フリーメール・自社ドメインは不可)。 */
export function isCompanyDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return !FREE_MAIL_DOMAINS.includes(d) && !OWN_MAIL_DOMAINS.includes(d);
}

/** どうやって営業先と結び付いたか。link = 画面で紐付けた / email = 担当者メールと一致 / domain = 担当者メールと同じ会社ドメイン。 */
export type MailMatchBy = "link" | "email" | "domain";

export interface LeadMatch {
  leadId: string;
  by: MailMatchBy;
}

/** 照合に使う営業先 (論理削除済みは渡さない)。 */
export type MatchableLead = Pick<LeadFields, "contactEmail"> & { id: string };

/** 画面で紐付けたアドレス。 */
export interface MailLinkRef {
  leadId: string;
  address: string;
}

/**
 * 相手のアドレス → 営業先。優先順は 紐付け → 担当者メールと完全一致 → 会社ドメインが一致。
 * 2 社以上に当たる (曖昧な) ときは更新しないので null (下の段にも落とさない)。
 */
export function buildLeadMatcher(leads: readonly MatchableLead[], links: readonly MailLinkRef[]): (address: string) => LeadMatch | null {
  const alive = new Set(leads.map((l) => l.id));
  const linked = new Map<string, string>();
  for (const k of links) {
    const a = normalizeAddress(k.address);
    if (a && alive.has(k.leadId)) linked.set(a, k.leadId);
  }
  const byAddress = new Map<string, Set<string>>();
  const byDomain = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, id: string) => map.set(key, (map.get(key) ?? new Set()).add(id));
  for (const l of leads) {
    for (const a of parseContactEmails(l.contactEmail)) {
      add(byAddress, a, l.id);
      if (isCompanyDomain(mailDomain(a))) add(byDomain, mailDomain(a), l.id);
    }
  }
  for (const [a, id] of linked) if (isCompanyDomain(mailDomain(a))) add(byDomain, mailDomain(a), id);

  return (raw) => {
    const address = normalizeAddress(raw);
    if (!address || OWN_MAIL_DOMAINS.includes(mailDomain(address))) return null;
    const link = linked.get(address);
    if (link) return { leadId: link, by: "link" };
    const exact = byAddress.get(address);
    if (exact) return exact.size === 1 ? { leadId: [...exact][0]!, by: "email" } : null;
    const dom = byDomain.get(mailDomain(address));
    return dom && dom.size === 1 ? { leadId: [...dom][0]!, by: "domain" } : null;
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

/** 画面で営業先に紐付けたメールアドレス (以後このアドレスとのメールはこの営業先として数える)。 */
export interface SponsorMailLink {
  id: string;
  leadId: string;
  address: string;
  /** 紐付けたスレッド (どのメールから紐付けたかの記録)。 */
  threadId: string | null;
  createdBy: UserId;
  createdByName: string | null;
  createdAt: ISODateTime;
}

export interface ListMailLinksResponse {
  links: SponsorMailLink[];
}

export interface CreateMailLinkRequest {
  address: string;
  threadId?: string | null;
}

export interface CreateMailLinkResponse {
  link: SponsorMailLink;
  /** 紐付け後の営業先 (担当者メールの補完・既存メールからの更新を反映済み)。 */
  lead: SponsorLead;
}

/** 自動更新の由来。live = 送受信した時 / link = 紐付けた時に既存メールから / backfill = 管理者の一括補完。 */
export type MailSyncSource = "live" | "link" | "backfill";

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

/** member-service → mail-gateway: このアドレス / ドメインとのメールの集計をください。 */
export interface MailContactsQuery {
  addresses: string[];
  domains: string[];
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
