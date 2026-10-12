// Client-side mail model for the Gmail-style UI. A UI-only, in-memory shape —
// folders, stars, labels, read-state and multi-message conversations — that powers
// the 3-pane experience. It carries NO seed data: the store starts empty and is
// hydrated from the real gateway (MailApi: GET /mail/messages received, GET /mail/sent
// sent). Star / archive / trash / label persistence is optimistic (a later slice
// persists it server-side). Nothing here is a Google asset — it is our own generic
// data shape. Demo fixtures used to live here; they now belong to tests only
// (mailModel.fixtures.ts).
import type { mail } from "@dub/types";

export type FolderId = "inbox" | "mine" | "others" | "starred" | "sent" | "scheduled" | "drafts" | "trash" | "archive";

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
  /** False when this received message reached the viewer only via oversight (mail:read_all)
   *  or role sharing (mail:read_role_shared), not their own mailbox. Absent = mine. */
  mine?: boolean;
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

/** A thread is unread when any of its messages is unread. */
export function threadUnread(t: MailThreadModel): boolean {
  return t.messages.some((m) => !m.read);
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
