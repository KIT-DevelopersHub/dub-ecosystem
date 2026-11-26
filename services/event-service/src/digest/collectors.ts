// Collectors: READ-ONLY views over existing APIs, each reduced to an allowlist of
// fields before anything leaves this file (#879 個人情報の決まり).
//
// Every mapper below is PURE and picks fields BY NAME from an `unknown` upstream
// record — never spreads it — so a field the upstream adds later (an email, a phone,
// a buyer name) cannot leak into a digest by accident. What each source may contribute:
//   tasks     title / due / status (no description, no assignee id)
//   tickets   per-type counts only (never orders, never buyers)
//   lp        published LP text (news / speakers / sponsors / partners)
//   sponsors  company name + stage (no contact person / email / phone)
//   meetings  date + title of the next meetings
//   chat      PINNED or 「決定」「確定」-marked messages of the event channel only (no chatter, no author)
//   mail      subject + sender DOMAIN only (never the body, never the address)
//   drive     file names in the ONE owner-chosen folder
// The roster is never read here. All free text passes safeText() (bounded + redacted).
import type { Fetcher } from "@cloudflare/workers-types";
import { createServiceClient, type RequestContext } from "@dub/http";
import { safeText } from "./pii";
import type { Collector, CollectCtx, DigestItem, SourceKind, SourceSnapshot } from "./types";
import type { EventRow, ActionRow, EventDetailsData } from "../types";

type Rec = Record<string, unknown>;
const MAX_ITEMS_PER_SOURCE = 30;

function rec(v: unknown): Rec | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null;
}
function arr(v: unknown): Rec[] {
  return Array.isArray(v) ? v.map(rec).filter((r): r is Rec => r !== null) : [];
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function day(iso: unknown): string {
  const s = str(iso);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : "";
}
function items(source: SourceKind, list: DigestItem[]): SourceSnapshot {
  return { source, items: list.filter((i) => i.text !== "" && i.link !== "").slice(0, MAX_ITEMS_PER_SOURCE) };
}

// ---- local sources (event-service's own rows) ----

export function mapEvent(ev: EventRow, details: EventDetailsData | null): SourceSnapshot {
  const link = `/events?eventId=${ev.id}`;
  const parts = [`イベント「${safeText(ev.title, 100)}」`];
  if (ev.startsAt) parts.push(`開催日 ${day(ev.startsAt)}`);
  if (ev.venue) parts.push(`会場 ${safeText(ev.venue, 100)}`);
  if (typeof ev.capacity === "number") parts.push(`定員 ${ev.capacity}人`);
  const snap = items("event", [{ source: "event", key: ev.id, text: parts.join("・"), link }]);
  // The legacy free-text 会場/定員 in the details store is a SOURCE, not the truth: it
  // can disagree with the structured fields, which is exactly a discrepancy to show.
  const facts: SourceSnapshot["facts"] = {};
  const legacyVenue = details ? safeText(details.venue, 100) : "";
  if (legacyVenue) facts.venue = legacyVenue;
  const legacyCap = details ? Number.parseInt(details.capacity.replace(/[^\d]/g, ""), 10) : NaN;
  if (Number.isFinite(legacyCap)) facts.capacity = legacyCap;
  return Object.keys(facts).length ? { ...snap, facts, factsLink: link } : snap;
}

export function mapActions(eventId: string, rows: ActionRow[]): SourceSnapshot {
  return items(
    "actions",
    rows
      .filter((a) => !a.archivedAt)
      .map((a) => ({ source: "actions", key: a.id, text: `アクション「${safeText(a.title, 100)}」`, link: `/events/${eventId}` })),
  );
}

// ---- remote sources (pure mappers) ----

const OPEN_TASK = new Set(["todo", "in_progress", "blocked"]);

/** Open tasks that are overdue or due within 7 days. */
export function mapTasks(raw: unknown, now: string): SourceSnapshot {
  const horizon = new Date(new Date(now).getTime() + 7 * 86_400_000).toISOString();
  const list = arr(rec(raw)?.items)
    .filter((t) => OPEN_TASK.has(str(t.status)) && str(t.dueAt) !== "" && str(t.dueAt) <= horizon)
    .sort((a, b) => str(a.dueAt).localeCompare(str(b.dueAt)))
    .map((t): DigestItem => {
      const overdue = str(t.dueAt) < now;
      return {
        source: "tasks",
        key: str(t.id),
        text: `タスク「${safeText(t.title, 100)}」期限 ${day(t.dueAt)}${overdue ? "（遅れ）" : ""}`,
        link: `/tasks/${encodeURIComponent(str(t.id))}`,
      };
    });
  return items("tasks", list);
}

/** Ticket counts per type. Reads `types[].stats` only — orders/buyers are never fetched. */
export function mapTickets(raw: unknown): SourceSnapshot {
  const list = arr(rec(raw)?.types)
    .filter((t) => t.active !== false)
    .map((t): DigestItem => {
      const stats = rec(t.stats);
      const sold = num(stats?.sold) ?? 0;
      const remaining = num(stats?.remaining);
      return {
        source: "tickets",
        key: str(t.id),
        text: `券種「${safeText(t.name, 60)}」販売 ${sold}枚${remaining === null ? "" : `・残り ${remaining}枚`}`,
        link: "/lp?tab=tickets",
      };
    });
  return items("tickets", list);
}

const LP_DATE = /開催日[:：\s]*(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})/;
const LP_VENUE = /会場[:：\s]+([^\s、。]+)/;

/** Published LP content (public text). Also extracts 開催日/会場 stated in news, for discrepancy checks. */
export function mapLp(raw: unknown, lpBaseUrl: string): SourceSnapshot {
  const content = rec(rec(rec(rec(raw)?.published)?.layout)?.content) ?? rec(rec(raw)?.content);
  const news = arr(content?.news);
  const out: DigestItem[] = [];
  const facts: NonNullable<SourceSnapshot["facts"]> = {};
  for (const n of news) {
    const text = safeText(n.text, 150);
    out.push({ source: "lp", key: `news:${str(n.id)}`, text: `LP お知らせ ${day(n.date)}「${text}」`, link: str(n.url).startsWith("https://") ? str(n.url) : lpBaseUrl });
    const d = LP_DATE.exec(str(n.text));
    if (d && !facts.startsAt) facts.startsAt = `${d[1]}-${d[2]!.padStart(2, "0")}-${d[3]!.padStart(2, "0")}`;
    const v = LP_VENUE.exec(str(n.text));
    if (v && !facts.venue) facts.venue = safeText(v[1], 100);
  }
  const speakers = arr(content?.speakers);
  if (speakers.length) {
    out.push({ source: "lp", key: "speakers", text: `LP 登壇者 ${speakers.length}名（${speakers.slice(0, 5).map((s) => safeText(s.name, 40)).join("、")}${speakers.length > 5 ? " ほか" : ""}）`, link: lpBaseUrl });
  }
  const sponsors = arr(content?.sponsors);
  if (sponsors.length) out.push({ source: "lp", key: "sponsors", text: `LP 掲載スポンサー ${sponsors.length}社`, link: lpBaseUrl });
  const partners = arr(content?.partners);
  if (partners.length) out.push({ source: "lp", key: "partners", text: `LP 協力団体 ${partners.length}団体`, link: lpBaseUrl });
  const snap = items("lp", out);
  return Object.keys(facts).length ? { ...snap, facts, factsLink: lpBaseUrl } : snap;
}

/** Sponsor pipeline: company name + stage only. Contact person/email/phone are dropped. */
export function mapSponsors(raw: unknown): SourceSnapshot {
  const r = rec(raw);
  const list = arr(r?.items ?? r?.inquiries).map((s): DigestItem => ({
    source: "sponsors",
    key: str(s.id),
    text: `協賛「${safeText(s.companyName ?? s.company, 60)}」${safeText(s.stage ?? s.status, 20)}`,
    link: "/sponsor",
  }));
  return items("sponsors", list.filter((i) => !i.text.startsWith("協賛「」")));
}

/** The next upcoming meetings: date + title only (no attendees, no notes body). */
export function mapMeetings(raw: unknown, now: string): SourceSnapshot {
  const list = arr(rec(raw)?.items ?? rec(raw)?.meetings)
    .filter((m) => str(m.startsAt) >= now)
    .sort((a, b) => str(a.startsAt).localeCompare(str(b.startsAt)))
    .slice(0, 3)
    .map((m): DigestItem => ({
      source: "meetings",
      key: str(m.id),
      text: `会議 ${day(m.startsAt)}「${safeText(m.title, 80)}」${m.minutesUrl || m.hasMinutes ? "（議事録あり）" : ""}`,
      link: "/calendar",
    }));
  return items("meetings", list);
}

const DECISION_MARK = /【?(決定|確定)】?|決まりました|に決定/;

/** Event-channel decisions: pinned, or carrying a 決定/確定 mark. Plain chatter is dropped. */
export function mapChat(rawMessages: unknown, pinnedIds: ReadonlySet<string>, eventId: string): SourceSnapshot {
  const link = `/chat?eventId=${encodeURIComponent(eventId)}`;
  const list = arr(rec(rawMessages)?.items ?? rawMessages)
    .filter((m) => pinnedIds.has(str(m.id)) || DECISION_MARK.test(str(m.body ?? m.text)))
    .map((m): DigestItem => ({ source: "chat", key: str(m.id), text: `チャットの決定「${safeText(m.body ?? m.text, 150)}」`, link }));
  return items("chat", list);
}

function senderDomain(from: unknown): string {
  const s = typeof from === "string" ? from : str(rec(from)?.address ?? rec(from)?.email);
  const at = s.lastIndexOf("@");
  if (at < 0) return "";
  return s.slice(at + 1).replace(/[>\s].*$/, "").toLowerCase();
}

/** Important mail: subject + sender domain. The body and the address are never read. */
export function mapMail(raw: unknown): SourceSnapshot {
  const list = arr(rec(raw)?.items ?? rec(raw)?.messages).map((m): DigestItem => {
    const domain = senderDomain(m.from);
    return {
      source: "mail",
      key: str(m.id),
      text: `メール「${safeText(m.subject, 100)}」${domain ? `（${domain}）` : ""}`,
      link: `/mail?messageId=${encodeURIComponent(str(m.id))}`,
    };
  });
  return items("mail", list);
}

/** File names inside the single owner-chosen folder (files outside it are ignored). */
export function mapDrive(raw: unknown, folderId: string): SourceSnapshot {
  const list = arr(rec(raw)?.files ?? rec(raw)?.items)
    .filter((f) => {
      const parents = Array.isArray(f.parents) ? f.parents : [];
      return parents.length === 0 || parents.includes(folderId);
    })
    .map((f): DigestItem => ({
      source: "drive",
      key: str(f.id),
      text: `ドライブ「${safeText(f.name, 100)}」${day(f.modifiedTime) ? ` 更新 ${day(f.modifiedTime)}` : ""}`,
      link: str(f.webViewLink).startsWith("https://") ? str(f.webViewLink) : `/drive?fileId=${encodeURIComponent(str(f.id))}`,
    }));
  return items("drive", list);
}

// ---- wiring: Service-Binding collectors (each optional; absent binding => skipped) ----

export interface RemoteBindings {
  SVC_TASK?: Fetcher;
  SVC_LP_TICKETS?: Fetcher;
  SVC_LP_ANALYTICS?: Fetcher;
  SVC_DRIVE_SHARE?: Fetcher;
  SVC_CHAT?: Fetcher;
  SVC_MAIL?: Fetcher;
  SVC_DRIVE?: Fetcher;
  LP_BASE_URL?: string;
  EVENT_AI_DIGEST_DRIVE_FOLDER_ID?: string;
}

type Get = (path: string, query?: Record<string, string | number>) => Promise<unknown>;

function remote(source: SourceKind, binding: Fetcher | undefined, service: string, run: (get: Get, ctx: CollectCtx) => Promise<SourceSnapshot>): Collector | null {
  if (!binding) return null;
  return {
    source,
    async collect(ctx) {
      const client = createServiceClient(binding, { service, caller: "event-service" });
      const rc: RequestContext = { requestId: ctx.requestId, userId: ctx.userId };
      const get: Get = (path, query) => client.get<unknown>(rc, path, query ? { query } : {});
      try {
        return await run(get, ctx);
      } catch {
        return null; // upstream down / 403: skip this source this run (never fail the whole digest)
      }
    },
  };
}

export function buildRemoteCollectors(env: RemoteBindings): Collector[] {
  const lpBase = env.LP_BASE_URL ?? "https://hokuriku-it-conf.com";
  const folder = env.EVENT_AI_DIGEST_DRIVE_FOLDER_ID;
  const list: (Collector | null)[] = [
    remote("tasks", env.SVC_TASK, "task-service", async (get, ctx) => mapTasks(await get("/tasks", { eventId: ctx.eventId, limit: 200 }), ctx.now)),
    remote("tickets", env.SVC_LP_TICKETS, "lp-tickets", async (get) => mapTickets(await get("/lp/internal/tickets"))),
    remote("lp", env.SVC_LP_ANALYTICS, "lp-analytics", async (get) => mapLp(await get("/lp/internal/site-config"), lpBase)),
    remote("sponsors", env.SVC_LP_ANALYTICS, "lp-analytics", async (get) => mapSponsors(await get("/lp/internal/sponsor-inquiries"))),
    remote("meetings", env.SVC_DRIVE_SHARE, "drive-share-service", async (get, ctx) => mapMeetings(await get("/meetings"), ctx.now)),
    remote("chat", env.SVC_CHAT, "chat-service", async (get, ctx) => {
      const channels = arr(rec(await get("/chat/channels", { eventId: ctx.eventId }))?.items);
      const ch = channels[0];
      if (!ch) return items("chat", []);
      const chId = str(ch.id);
      const pins = arr(rec(await get(`/chat/channels/${encodeURIComponent(chId)}/pins`))?.items);
      const pinned = new Set(pins.map((p) => str(p.messageId ?? p.id)));
      return mapChat(await get("/chat/messages", { channelId: chId, limit: 100 }), pinned, ctx.eventId);
    }),
    remote("mail", env.SVC_MAIL, "mail-gateway", async (get) => mapMail(await get("/mail/messages", { limit: 30, flagged: "true" }))),
    folder ? remote("drive", env.SVC_DRIVE, "drive-proxy", async (get) => mapDrive(await get("/drive/files", { parentId: folder }), folder)) : null,
  ];
  return list.filter((c): c is Collector => c !== null);
}
