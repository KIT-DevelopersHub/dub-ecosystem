// Client-side mail model for the Gmail-style UI. A UI-only, in-memory shape —
// folders, stars, labels, read-state and multi-message conversations — that powers
// the 3-pane experience. It carries NO seed data: the store starts empty and is
// hydrated from the real gateway (MailApi: GET /mail/messages received, GET /mail/sent
// sent). Star / archive / trash / label persistence is optimistic (a later slice
// persists it server-side). Nothing here is a Google asset — it is our own generic
// data shape. Demo fixtures used to live here; they now belong to tests only
// (mailModel.fixtures.ts).

export type FolderId = "inbox" | "starred" | "sent" | "drafts" | "trash" | "archive";

/** Folders that appear in the left nav (archive is Gmail's "All Mail"-ish sink). */
export const NAV_FOLDERS: { id: FolderId; label: string; icon: string }[] = [
  { id: "inbox", label: "受信トレイ", icon: "inbox" },
  { id: "starred", label: "スター付き", icon: "star" },
  { id: "sent", label: "送信済み", icon: "send" },
  { id: "drafts", label: "下書き", icon: "draft" },
  { id: "trash", label: "ゴミ箱", icon: "trash" },
];

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
  from: MailPerson;
  to: MailPerson[];
  cc?: MailPerson[];
  date: string; // ISO
  body: string; // plain text (pre-wrap)
  read: boolean;
}

export interface MailThreadModel {
  id: string;
  subject: string;
  messages: MailMsg[];
  folder: FolderId;
  starred: boolean;
  labels: string[]; // Label ids
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
