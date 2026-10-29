// Client-side mail model for the Gmail-style UI. A UI-only, in-memory shape —
// folders, stars, labels, read-state and multi-message conversations — that powers
// the 3-pane experience. It carries NO seed data: the store starts empty and is
// hydrated from the real gateway (MailApi: GET /mail/messages received, GET /mail/sent
// sent). Star / archive / trash / label persistence is optimistic (a later slice
// persists it server-side). Nothing here is a Google asset — it is our own generic
// data shape. Demo fixtures used to live here; they now belong to tests only
// (mailModel.fixtures.ts).
import type { mail } from "@dub/types";

export type FolderId = "inbox" | "mine" | "others" | "starred" | "sent" | "scheduled" | "drafts" | "trash" | "archive" | "blocked";

/** Folders that appear in the left nav (archive is Gmail's "All Mail"-ish sink).
 *  `scheduled` (予約済み) is NOT thread-backed — it lists parked future sends from a
 *  separate store slice (see ScheduledList), so it renders its own pane.
 *  `mine` / `others` are filter views over the inbox (自分宛て / ロール共有・監督で見えるもの);
 *  the sidebar hides them unless the viewer actually has a non-mine thread (SHARED_FOLDERS). */
export const NAV_FOLDERS: { id: FolderId; label: string; icon: string }[] = [
  { id: "inbox", label: "受信トレイ", icon: "inbox" },
  { id: "mine", label: "自分宛て", icon: "person" },
  { id: "others", label: "自分宛て以外", icon: "people" },
  { id: "starred", label: "スター付き", icon: "star" },
  { id: "sent", label: "送信済み", icon: "send" },
  { id: "scheduled", label: "予約済み", icon: "clock" },
  { id: "drafts", label: "下書き", icon: "draft" },
  { id: "trash", label: "ゴミ箱", icon: "trash" },
  { id: "blocked", label: "ブロック済み", icon: "block" },
];

/** Inbox filter views that only make sense when some mail is NOT addressed to the viewer. */
export const SHARED_FOLDERS: ReadonlySet<FolderId> = new Set<FolderId>(["mine", "others"]);

export interface Label {
  id: string;
  name: string;
  color: string; // token var or hex accent for the label chip/dot
}

export interface MailPerson {
  email: string;
  name?: string;
}

export interface MailMsg {
  id: string;
  /** RFC Message-Id of this message (received mail). Drives reply threading:
   *  a reply sets In-Reply-To/References to it so the recipient's client threads
   *  the conversation and a further reply carries the chain back to us. Absent for
   *  optimistic/local rows the client mints before the server round-trip. */
  messageId?: string;
  from: MailPerson;
  to: MailPerson[];
  cc?: MailPerson[];
  /** Bcc recipients — only on our own sent messages (the gateway returns them to the sender only). */
  bcc?: MailPerson[];
  date: string; // ISO
  body: string; // plain text (pre-wrap)
  read: boolean;
  /** True when WE sent this message (compose/reply/folded Sent row). Used to (a) keep our
   *  replies visible in a conversation across a getThread refresh and (b) target a reply
   *  at the last message that ISN'T ours (the external correspondent), never at ourselves. */
  outbound?: boolean;
  /** Attachment METADATA for this message (bytes live in R2; each links to a gateway
   *  download route). Filled only from the full detail fetch (getThread / getSent) —
   *  the list/snippet endpoints omit it — so it is absent for list-derived rows. A
   *  `status` other than "stored" marks an attachment the gateway could NOT persist
   *  (too large / message truncated), surfaced as a disabled chip rather than silently
   *  dropped (改善#2). */
  attachments?: mail.MailAttachment[];
  /** Delivery details (Reply-To / mailed-by / signed-by / TLS / delivered-to) for the
   *  "show details" dialog. Received messages only, from the detail fetch (getThread). */
  headerMeta?: mail.MailHeaderMeta;
  /** False when this received message reached the viewer only via oversight (mail:read_all)
   *  or role sharing (mail:read_role_shared), not their own mailbox. Absent = mine. */
  mine?: boolean;
  /** Server verdict (GET /mail/messages etc.): the sender is on the viewer's block list.
   *  Only consulted until the client has the block list itself (see threadBlocked). */
  blocked?: boolean;
}

export interface MailThreadModel {
  id: string;
  subject: string;
  messages: MailMsg[];
  folder: FolderId;
  starred: boolean;
  labels: string[]; // Label ids
  /** 完全に削除 (purge): the signed-in user permanently removed this conversation from THEIR
   *  mailbox (Gmail's "完全に削除" out of Trash). One-way, per-user, view-only — the thread
   *  stays in the store but is filtered out of every folder for this viewer. Never a physical
   *  delete: other accounts/admins still see it. Absent/false = normal. */
  purged?: boolean;
  /** 返信不要: when the viewer dismissed the reply nudge (ISO). Covers only mail received up
   *  to then — a newer received message brings the nudge back. Absent/null = not dismissed. */
  noReplyAt?: string | null;
  /** Derived (never persisted): every received message is from a sender on the viewer's
   *  block list. Recomputed by the store whenever threads or the block list change. Blocked
   *  threads leave 受信トレイ / 自分宛て / スター付き / unread counts and show only under
   *  ブロック済み — nothing is deleted, so unblocking puts them straight back. */
  blocked?: boolean;
}

// ---- pure helpers ----

export function displayName(p: MailPerson): string {
  return p.name && p.name.trim().length > 0 ? p.name : p.email;
}

/** First grapheme-ish char, upper-cased, for the round avatar. */
export function initial(p: MailPerson): string {
  const src = (p.name && p.name.trim()) || p.email;
  return src.slice(0, 1).toUpperCase();
}

/** A thread is unread when any of the viewer's own messages is unread (others' mail is
 *  view-only, so it never counts). */
export function threadUnread(t: MailThreadModel): boolean {
  return t.messages.some((m) => !m.read && m.mine !== false);
}

/** A thread is "mine" when any received message was delivered to the viewer (absent = mine).
 *  Sent-only threads are always mine. */
export function threadMine(t: MailThreadModel): boolean {
  const inbound = t.messages.filter((m) => !m.outbound);
  return inbound.length === 0 || inbound.some((m) => m.mine !== false);
}

/** Does the viewer see any mail not addressed to them? Gates the 自分宛て / 自分宛て以外 views. */
export function hasSharedMail(threads: MailThreadModel[]): boolean {
  return threads.some((t) => !t.purged && t.folder !== "sent" && !threadMine(t));
}

/** Whose mailbox a non-mine thread came from: the first `to` of its first received message. */
export function sharedRecipientLabel(t: MailThreadModel): string {
  const p = t.messages.find((m) => !m.outbound)?.to[0];
  return p && (p.name?.trim() || p.email) ? `${displayName(p)} 宛て` : "共有メール";
}

/** Newest message drives the row's timestamp + preview. */
export function latest(t: MailThreadModel): MailMsg {
  return t.messages[t.messages.length - 1]!;
}

/** Gmail-style compact timestamp: today -> time, this year -> M/D, else Y/M/D. */
export function relativeDate(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** Full timestamp for the reading pane. */
export function fullDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ja-JP");
}

/** One-line preview snippet from a body. */
export function snippet(body: string, max = 100): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Deterministic pastel-ish avatar hue from an email, so each sender is stable. */
export function avatarColor(p: MailPerson): string {
  const src = p.email;
  let h = 0;
  for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) % 360;
  return `hsl(${h} 55% 45%)`;
}

/** Does a thread belong to the given folder view? */
export function inFolder(t: MailThreadModel, folder: FolderId): boolean {
  // Blocked mail lives only under ブロック済み (Trash/Sent keep their own semantics).
  if (folder === "blocked") return t.blocked === true && t.folder !== "trash" && t.folder !== "sent";
  if (t.blocked && folder !== "trash" && folder !== "sent" && folder !== "drafts") return false;
  if (folder === "starred") return t.starred && t.folder !== "trash";
  if (folder === "mine") return t.folder === "inbox" && threadMine(t);
  if (folder === "others") return t.folder === "inbox" && !threadMine(t);
  return t.folder === folder;
}

/** Free-text search across subject / participants / bodies (excludes trash). */
export function matchesQuery(t: MailThreadModel, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (needle.length === 0) return true;
  if (t.subject.toLowerCase().includes(needle)) return true;
  return t.messages.some(
    (m) =>
      m.body.toLowerCase().includes(needle) ||
      displayName(m.from).toLowerCase().includes(needle) ||
      m.from.email.toLowerCase().includes(needle),
  );
}

/** Neutral "self" identity for optimistic compose/send rows before hydration replaces
 *  them with the server's real From. The client never learns its own @developershub.jp
 *  address (/me omits email); the gateway resolves the real From server-side. */
export const SELF: MailPerson = { email: "", name: "自分" };

// ---- reply nudge (Gmail's "N日前に受信しました。返信しますか？") ----

/** Whole days a received message may sit unanswered before the nudge appears. */
export const NUDGE_DAYS = 3;
/** Past this the mail is stale; nagging about it is clutter, not help. */
export const NUDGE_MAX_DAYS = 14;
const DAY_MS = 86_400_000;
const AUTOMATED_SENDER = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|bounce)/i;
const bareId = (id: string): string => id.trim().replace(/^<|>$/g, "").trim();

/** Message-Ids (brackets stripped) that a still-pending scheduled send replies to. */
export function pendingReplyIds(scheduled: readonly mail.ScheduledSendListItem[]): Set<string> {
  const ids = new Set<string>();
  for (const s of scheduled) if (s.status === "scheduled" && s.inReplyTo) ids.add(bareId(s.inReplyTo));
  return ids;
}

/** True when 返信不要 was pressed after the given (latest received) message arrived. */
export function nudgeDismissed(t: MailThreadModel, last: MailMsg): boolean {
  if (!t.noReplyAt) return false;
  const at = new Date(t.noReplyAt).getTime();
  const got = new Date(last.date).getTime();
  return !Number.isNaN(at) && !Number.isNaN(got) && got <= at;
}

/** Derived (no state): non-null when a read inbox thread addressed to the viewer ends with a
 *  received message from a human, unanswered for days..maxDays whole days, no scheduled
 *  reply is pending for it, and the viewer has not marked it 返信不要 since it arrived.
 *  A reply appends an outbound message, so the nudge clears itself. */
export function replyNudge(
  t: MailThreadModel,
  now: Date,
  pendingReplies: ReadonlySet<string> = new Set(),
  days: number = NUDGE_DAYS,
  maxDays: number = NUDGE_MAX_DAYS,
): { days: number } | null {
  if (t.purged || t.blocked || t.folder !== "inbox" || t.messages.length === 0 || threadUnread(t)) return null;
  const last = latest(t);
  if (last.outbound || last.mine === false) return null;
  if (AUTOMATED_SENDER.test(last.from.email.split("@")[0] ?? "")) return null;
  if (nudgeDismissed(t, last)) return null;
  if (t.messages.some((m) => m.messageId && pendingReplies.has(bareId(m.messageId)))) return null;
  const at = new Date(last.date).getTime();
  if (Number.isNaN(at)) return null;
  const elapsed = Math.floor((now.getTime() - at) / DAY_MS);
  return elapsed >= days && elapsed <= maxDays ? { days: elapsed } : null;
}

/** Splits a list into nudged threads (pinned above the inbox so they don't sink under new
 *  mail, like Gmail bumping a nudge to the top) and the rest; both keep their input order. */
export function partitionNudged(
  threads: readonly MailThreadModel[],
  now: Date,
  pendingReplies: ReadonlySet<string> = new Set(),
): { nudged: MailThreadModel[]; rest: MailThreadModel[] } {
  const nudged: MailThreadModel[] = [];
  const rest: MailThreadModel[] = [];
  for (const t of threads) (replyNudge(t, now, pendingReplies) ? nudged : rest).push(t);
  return { nudged, rest };
}

const normEmail = (email: string): string => email.trim().toLowerCase();

/** Case-insensitive dedupe by email; first occurrence wins. Drops empty addresses. */
export function dedupPeople(ps: readonly MailPerson[], skip: ReadonlySet<string> = new Set()): MailPerson[] {
  const seen = new Set(skip);
  const out: MailPerson[] = [];
  for (const p of ps) {
    const key = normEmail(p.email);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** Reply-all (Gmail/RFC 5322 §3.6.3): To = reply target (Reply-To else From) + original To,
 *  Cc = original Cc. `own` (lowercased) is dropped from both; an address in To never repeats in Cc. */
export function replyAllRecipients(msg: MailMsg, own: ReadonlySet<string>): { to: MailPerson[]; cc: MailPerson[] } {
  const target = msg.headerMeta?.replyTo?.length ? msg.headerMeta.replyTo : [msg.from];
  const to = dedupPeople([...target, ...msg.to], own);
  const cc = dedupPeople(msg.cc ?? [], new Set([...own, ...to.map((p) => normEmail(p.email))]));
  return { to, cc };
}

/** Address-book candidates for recipient fields: everyone the user has corresponded with
 *  (From/To/Cc across loaded threads), excluding self, deduped by email. */
export function addressCandidates(threads: MailThreadModel[], meEmail: string): Array<{ email: string; name?: string }> {
  const byEmail = new Map<string, { email: string; name?: string }>();
  for (const t of threads) {
    for (const m of t.messages) {
      for (const p of [m.from, ...m.to, ...(m.cc ?? [])]) {
        if (p.email && p.email !== meEmail && !byEmail.has(p.email)) {
          byEmail.set(p.email, p.name ? { email: p.email, name: p.name } : { email: p.email });
        }
      }
    }
  }
  return [...byEmail.values()];
}

// ---- sender block list (この送信者をブロック) ----

/** Our own organization domain: blocking it domain-wide is refused (server enforces too). */
export const ORG_MAIL_DOMAIN = "developershub.jp";

export type BlockKind = mail.MailSenderBlockKind;

/** Lowercased domain part of an address ("" when there is none). */
export function domainOf(email: string): string {
  const e = normEmail(email);
  const at = e.lastIndexOf("@");
  return at < 0 ? "" : e.slice(at + 1);
}

/** Mirrors the gateway's matcher: exact address, or the sender's domain / any parent domain. */
export function senderMatcher(blocks: readonly Pick<mail.MailSenderBlock, "value" | "kind">[]): (email: string) => boolean {
  const addresses = new Set<string>();
  const domains = new Set<string>();
  for (const b of blocks) (b.kind === "domain" ? domains : addresses).add(b.value);
  return (email) => {
    const e = normEmail(email);
    if (!e) return false;
    if (addresses.has(e)) return true;
    let d = domainOf(e);
    while (d.includes(".")) {
      if (domains.has(d)) return true;
      d = d.slice(d.indexOf(".") + 1);
    }
    return false;
  };
}

/** True when the thread has received mail and ALL of it comes from blocked senders. A mixed
 *  conversation (someone unblocked also wrote) stays in the inbox so their mail isn't hidden.
 *  `match` = the client's block list; without it (not loaded yet) the server verdict is used. */
export function threadBlocked(t: MailThreadModel, match: ((email: string) => boolean) | null): boolean {
  const inbound = t.messages.filter((m) => !m.outbound);
  if (inbound.length === 0) return false;
  return inbound.every((m) => (match ? match(m.from.email) : m.blocked === true));
}

/** The external sender a block action in the reading pane targets: the newest received
 *  message's From. null for a sent-only conversation. */
export function blockTarget(t: MailThreadModel): MailPerson | null {
  const last = [...t.messages].reverse().find((m) => !m.outbound && m.from.email.trim() !== "");
  return last ? last.from : null;
}

/** The block entry (address or domain) that currently hides this sender, if any. */
export function matchingBlock(
  email: string,
  blocks: readonly mail.MailSenderBlock[],
): mail.MailSenderBlock | null {
  const e = normEmail(email);
  const exact = blocks.find((b) => b.kind === "address" && b.value === e);
  if (exact) return exact;
  return blocks.find((b) => b.kind === "domain" && senderMatcher([b])(e)) ?? null;
}
