// Mail list filters (#899): the client model, its URL form (so a reload keeps them) and the
// gateway query it becomes. Filters work like the search box: they span every folder but
// Trash / ブロック済み, the server does the narrowing (GET /mail/messages + GET /mail/sent
// with the #899 keys) and the results merge into the store like search results.
import type { MailFilterQuery } from "../../mailApi.tsx";
import type { MailThreadModel } from "../mailModel.ts";

export type ReadFilter = "unread" | "read";
export type DirectionFilter = "received" | "sent";

export interface MailFilters {
  read?: ReadFilter;
  direction?: DirectionFilter;
  from?: string;
  to?: string;
  mailbox?: string;
  starred?: true;
  attachment?: true;
  /** yyyy-mm-dd, local day (inclusive). */
  after?: string;
  /** yyyy-mm-dd, local day (inclusive). */
  before?: string;
}

export const NO_FILTERS: MailFilters = {};
export type FilterKey = keyof MailFilters;

/** URL query keys. `open` (MAIL_OPEN_QUERY_PARAM) and anything else on the URL is left alone. */
const URL_KEYS: Record<FilterKey, string> = {
  read: "read",
  direction: "dir",
  from: "from",
  to: "to",
  mailbox: "mailbox",
  starred: "starred",
  attachment: "attachment",
  after: "after",
  before: "before",
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const address = (v: string | null): string | undefined => {
  const a = v?.trim().toLowerCase();
  return a && EMAIL_RE.test(a) ? a : undefined;
};
const day = (v: string | null): string | undefined => (v && DATE_RE.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined);

/** Read filters from a URL query string. Anything malformed is dropped, never thrown. */
export function parseFilters(search: string): MailFilters {
  const p = new URLSearchParams(search);
  const f: MailFilters = {};
  const read = p.get(URL_KEYS.read);
  if (read === "unread" || read === "read") f.read = read;
  const dir = p.get(URL_KEYS.direction);
  if (dir === "received" || dir === "sent") f.direction = dir;
  const from = address(p.get(URL_KEYS.from));
  if (from) f.from = from;
  const to = address(p.get(URL_KEYS.to));
  if (to) f.to = to;
  const mailbox = address(p.get(URL_KEYS.mailbox));
  if (mailbox) f.mailbox = mailbox;
  if (p.get(URL_KEYS.starred) === "1") f.starred = true;
  if (p.get(URL_KEYS.attachment) === "1") f.attachment = true;
  const after = day(p.get(URL_KEYS.after));
  if (after) f.after = after;
  const before = day(p.get(URL_KEYS.before));
  if (before) f.before = before;
  return f;
}

/** Write filters into a URL query string, keeping its other params (e.g. ?open=). */
export function writeFilters(search: string, f: MailFilters): string {
  const p = new URLSearchParams(search);
  for (const k of Object.keys(URL_KEYS) as FilterKey[]) {
    const v = f[k];
    if (v === undefined) p.delete(URL_KEYS[k]);
    else p.set(URL_KEYS[k], v === true ? "1" : v);
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function activeFilterCount(f: MailFilters): number {
  return (Object.keys(f) as FilterKey[]).filter((k) => f[k] !== undefined).length;
}
export const filtersActive = (f: MailFilters): boolean => activeFilterCount(f) > 0;

/** Stable identity of a filter set (part of the search key). */
export function filterKey(f: MailFilters): string {
  return (Object.keys(URL_KEYS) as FilterKey[])
    .filter((k) => f[k] !== undefined)
    .map((k) => `${k}=${String(f[k])}`)
    .join("&");
}

/** Remove one filter (the × on its active chip). */
export function withoutFilter(f: MailFilters, key: FilterKey): MailFilters {
  const { [key]: _drop, ...rest } = f;
  return rest;
}

/** Start of a local day as an ISO instant. */
const localDayStart = (d: string, plusDays = 0): string => {
  const [y, m, dd] = d.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, dd + plusDays).toISOString();
};

/** The gateway query per list, or null when that list cannot hold a match (受信 skips Sent,
 *  送信 skips the inbox, 未読 skips Sent — a sent message is never unread). */
export function toApiFilters(f: MailFilters): { inbox: MailFilterQuery | null; sent: MailFilterQuery | null } {
  const q: MailFilterQuery = {};
  if (f.read) q.unread = f.read === "unread" ? "1" : "0";
  if (f.from) q.from = f.from;
  if (f.to) q.to = f.to;
  if (f.mailbox) q.mailbox = f.mailbox;
  if (f.starred) q.starred = "1";
  if (f.attachment) q.hasAttachment = "1";
  if (f.after) q.after = localDayStart(f.after);
  if (f.before) q.before = localDayStart(f.before, 1);
  return {
    inbox: f.direction === "sent" ? null : q,
    sent: f.direction === "received" || f.read === "unread" ? null : q,
  };
}

const fmtDay = (d: string): string => {
  const [, m, dd] = d.split("-").map(Number);
  return `${m}/${dd}`;
};

/** Active-filter chips: one per set filter, in a fixed order. */
export function describeFilters(f: MailFilters, nameOf: (email: string) => string = (e) => e): { key: FilterKey; label: string }[] {
  const out: { key: FilterKey; label: string }[] = [];
  if (f.read) out.push({ key: "read", label: f.read === "unread" ? "未読" : "既読" });
  if (f.direction) out.push({ key: "direction", label: f.direction === "received" ? "受信のみ" : "送信のみ" });
  if (f.starred) out.push({ key: "starred", label: "スター付き" });
  if (f.attachment) out.push({ key: "attachment", label: "添付あり" });
  if (f.from) out.push({ key: "from", label: `差出人: ${nameOf(f.from)}` });
  if (f.to) out.push({ key: "to", label: `宛先: ${nameOf(f.to)}` });
  if (f.mailbox) out.push({ key: "mailbox", label: `受信アドレス: ${f.mailbox}` });
  if (f.after) out.push({ key: "after", label: `${fmtDay(f.after)} 以降` });
  if (f.before) out.push({ key: "before", label: `${fmtDay(f.before)} まで` });
  return out;
}

export interface KnownAddress {
  email: string;
  name?: string;
}

/** Everyone in the loaded mail (senders + recipients) plus the viewer, for the address pickers. */
export function knownAddresses(threads: readonly MailThreadModel[], me: KnownAddress, extra: readonly string[] = []): KnownAddress[] {
  const by = new Map<string, KnownAddress>();
  const add = (p: { email?: string; name?: string } | undefined): void => {
    const email = p?.email?.trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) return;
    const had = by.get(email);
    if (!had || (!had.name && p?.name)) by.set(email, { email, ...(p?.name ? { name: p.name } : {}) });
  };
  add(me);
  for (const t of threads) for (const m of t.messages) [m.from, ...m.to, ...(m.cc ?? [])].forEach(add);
  for (const e of extra) add({ email: e });
  return [...by.values()].sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email, "ja"));
}

/** Addresses the viewer receives at, for the 受信アドレス picker (shown only when there are
 *  several): the To addresses of the viewer's own received mail on the organization's domain —
 *  the viewer's domain when known, else the domain most received mail is addressed to — e.g.
 *  their own address plus a shared mailbox such as info@ or a team list. */
export function receivingAddresses(threads: readonly MailThreadModel[], meEmail: string, extra: readonly string[] = []): string[] {
  const me = meEmail.trim().toLowerCase();
  const tos: string[] = [];
  for (const t of threads)
    for (const m of t.messages) {
      if (m.outbound || m.mine === false) continue;
      for (const p of m.to) {
        const e = p.email?.trim().toLowerCase();
        if (e && EMAIL_RE.test(e)) tos.push(e);
      }
    }
  const domainOf = (e: string): string => e.split("@")[1] ?? "";
  let domain = me ? domainOf(me) : "";
  if (!domain) {
    const freq = new Map<string, number>();
    for (const e of tos) freq.set(domainOf(e), (freq.get(domainOf(e)) ?? 0) + 1);
    domain = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  }
  const out = new Set<string>(me ? [me] : []);
  for (const e of tos) if (domain && domainOf(e) === domain) out.add(e);
  for (const e of extra) if (e) out.add(e);
  return [...out].sort();
}
