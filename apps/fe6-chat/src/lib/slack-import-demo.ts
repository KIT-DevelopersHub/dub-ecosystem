// Backend-free Slack import simulator for the standalone mock (MockChatClient) and the
// fe2 VITE_DEMO transport. Mirrors chat-service's job semantics (one job per Slack
// channel, failed -> resume from cursor, done -> restart, rate-limit park via
// retryAfterMs) and, on completion, hands the host the Dub channel content an import
// would have produced: a thread, reactions (incl. a custom emoji), disabled placeholder
// authors ("(bot)" for bots), a pinned bookmark post, a pinned message and attachments.
import type { Message, SlackChannelOption, SlackImportCounters, SlackImportJob, SlackImportPhase } from "../api/contract";
import { JOB_ERROR_MESSAGES } from "./slack-import";

interface SlackChannelSeed {
  id: string;
  name: string;
  isPrivate: boolean;
  isArchived: boolean;
  memberCount: number;
  topic: string;
}

export const DEMO_SLACK_CHANNELS: readonly SlackChannelSeed[] = [
  { id: "C01GENERAL", name: "general", isPrivate: false, isArchived: false, memberCount: 42, topic: "Slack 時代の全体連絡" },
  { id: "C02RANDOM", name: "random", isPrivate: false, isArchived: false, memberCount: 38, topic: "雑談" },
  { id: "G03CONFCORE", name: "conference-core", isPrivate: true, isArchived: false, memberCount: 9, topic: "カンファレンス運営コア" },
  { id: "C04DESIGN", name: "design-review", isPrivate: false, isArchived: false, memberCount: 12, topic: "デザインレビュー" },
  { id: "G05SPONSOR", name: "sponsor-private", isPrivate: true, isArchived: false, memberCount: 6, topic: "協賛交渉（非公開）" },
  { id: "C06LTNIGHT", name: "lt-night", isPrivate: false, isArchived: false, memberCount: 27, topic: "LT ナイト企画" },
  { id: "C07HACK25", name: "kit-hackathon-2025", isPrivate: false, isArchived: true, memberCount: 31, topic: "2025 ハッカソン（終了）" },
];

/** Dub user ids the imported posts are attributed to (host-specific seed users). */
export interface SlackDemoAuthors {
  me: string;
  a: string;
  b: string;
  /** A real Dub account that is disabled (退会済み) — still matched by email. */
  disabled: string;
}

export interface PlaceholderUser {
  id: string;
  displayName: string;
}

/** Disabled placeholder users the importer creates for unmatched / bot authors. */
export const SLACK_PLACEHOLDER_USERS: readonly PlaceholderUser[] = [
  { id: "usr_slk_bot_github", displayName: "GitHub (bot)" },
  { id: "usr_slk_bot_lmb", displayName: "LMB (bot)" },
  { id: "usr_slk_ishikawa", displayName: "石川 涼" },
];

export interface ImportedChannel {
  id: string;
  name: string;
  topic: string;
  visibility: "public" | "private";
  archived: boolean;
  memberCount: number;
  messages: Message[];
  pinnedIds: string[];
  placeholderUsers: PlaceholderUser[];
}

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAAA8CAIAAAAWtijjAAAAkUlEQVR42u3ZuwnAMAxAQU+X1mOnzw4ZwIWLNCYDKBhcOD8OXi3QdUKp1EOdEgJAgAABAgQIEKBQXvbYurWhLod0emo+IED3A3164dH5gAABAgQIECBAgAABAvQSIMcqIECAAAECBAgQIECAAPmLueYBAQIECBAgQIAAAQLkL+ZYBQQI0FwgAQIECBAgQID+3Alsj3uDlc8soAAAAABJRU5ErkJggg==";

export function dubChannelIdFor(slackChannelId: string): string {
  return `chn_slk_${slackChannelId.toLowerCase()}`;
}

/** The Dub channel + posts an import of `channel` produces (deterministic per channel). */
export function importedChannelContent(channel: SlackChannelSeed, who: SlackDemoAuthors, nowMs: number): ImportedChannel {
  const id = dubChannelIdFor(channel.id);
  const prefix = `msg_01SLK${channel.id}`;
  let seq = 0;
  const at = (daysAgo: number, minutes = 0) => new Date(nowMs - daysAgo * 86_400_000 + minutes * 60_000).toISOString();
  const msg = (over: Partial<Message> & { authorId: string | null; body: string; createdAt: string }): Message => ({
    id: `${prefix}${String(++seq).padStart(4, "0")}`,
    channelId: id,
    threadRootId: null,
    replyCount: 0,
    reactions: [],
    attachments: [],
    editedAt: null,
    deletedAt: null,
    version: 1,
    ...over,
  });
  const bookmark = msg({
    authorId: null,
    body: `📌 ブックマーク（Slack #${channel.name} から取り込み）\n運営ドライブ: https://drive.google.com/drive/folders/devhub-ops\nタイムテーブル: https://docs.google.com/spreadsheets/d/devhub-timetable`,
    createdAt: at(80),
  });
  const root = msg({
    authorId: who.a,
    body: "来週の定例は *10:00* 開始です。アジェンダはこのスレッドにお願いします 🙏",
    replyCount: 3,
    reactions: [
      { emoji: "👍", userIds: [who.b, who.disabled, "usr_slk_ishikawa"] },
      { emoji: "🙏", userIds: [who.me] },
      { emoji: ":kit-dev:", userIds: [who.a] },
    ],
    createdAt: at(60),
  });
  const replies = [
    msg({ authorId: who.b, body: "受付導線の確認を議題に入れてください！", threadRootId: root.id, createdAt: at(60, 12) }),
    msg({ authorId: "usr_slk_ishikawa", body: "会場の電源配置図を共有します。", threadRootId: root.id, createdAt: at(60, 30) }),
    msg({ authorId: who.me, body: "了解です、両方アジェンダに入れました。", threadRootId: root.id, createdAt: at(59) }),
  ];
  const github = msg({
    authorId: "usr_slk_bot_github",
    body: "> *[dub-ecosystem] Pull request merged*\n> #612 fe6: 既読同期の改善",
    reactions: [{ emoji: "🎉", userIds: [who.a] }],
    createdAt: at(41),
  });
  const layout = msg({
    authorId: who.disabled,
    body: "会場レイアウト案を添付します（PDF は印刷用）。",
    editedAt: at(30, 5),
    attachments: [
      { fileId: `fil_slk_${channel.id.toLowerCase()}_1`, name: "venue-layout.png", mime: "image/png", size: 202, url: PNG_DATA_URL },
      { fileId: `fil_slk_${channel.id.toLowerCase()}_2`, name: "venue-layout-print.pdf", mime: "application/pdf", size: 482_133, url: null },
    ],
    createdAt: at(30),
  });
  const reminder = msg({ authorId: "usr_slk_bot_lmb", body: "リマインド: 参加登録の締切は明日 23:59 です。", createdAt: at(12) });
  const logos = msg({
    authorId: who.b,
    body: "スポンサーロゴの最終版はドライブに置きました https://drive.google.com/drive/folders/devhub-logos",
    reactions: [{ emoji: "👀", userIds: [who.me] }],
    createdAt: at(3),
  });
  return {
    id,
    name: channel.name,
    topic: channel.topic,
    visibility: channel.isPrivate ? "private" : "public",
    archived: channel.isArchived,
    memberCount: 4,
    messages: [bookmark, root, ...replies, github, layout, reminder, logos],
    pinnedIds: [bookmark.id, reminder.id],
    placeholderUsers: [...SLACK_PLACEHOLDER_USERS],
  };
}

// Counter totals an import of the content above reports (bookmark post excluded).
const FINAL: SlackImportCounters = { members: 4, messages: 5, threadReplies: 3, reactions: 7, pins: 1, files: 2, filesSkipped: 1 };

type ScriptStep =
  | { kind: "advance"; to: SlackImportPhase; add: Partial<SlackImportCounters>; pending?: { threads: number; files: number } }
  | { kind: "rateLimit"; waitMs: number };

// One entry per step call (mirrors the engine's phase transitions).
const SCRIPT: readonly ScriptStep[] = [
  { kind: "advance", to: "channel", add: { members: FINAL.members } },
  { kind: "advance", to: "history", add: {} },
  { kind: "advance", to: "history", add: { messages: 3, reactions: 4 } },
  { kind: "rateLimit", waitMs: 1_500 },
  { kind: "advance", to: "threads", add: { messages: 2, reactions: 3, pins: 1 }, pending: { threads: 1, files: 0 } },
  { kind: "advance", to: "files", add: { threadReplies: 3 }, pending: { threads: 0, files: 3 } },
  { kind: "advance", to: "finalize", add: { files: 2, filesSkipped: 1 } },
  { kind: "advance", to: "done", add: {} },
];

export type SimResult<T> = { ok: true; status: number; value: T } | { ok: false; status: number; code: string; message: string };

interface SimJob {
  job: SlackImportJob;
  cursor: number;
  parkedUntil: number;
}

export interface SlackImportSimOptions {
  authors: SlackDemoAuthors;
  /** Epoch ms clock (injectable for tests). */
  clock?: () => number;
  /** A job reached done: materialize (idempotently) the imported Dub channel. */
  onDone: (content: ImportedChannel, job: SlackImportJob) => void;
}

const emptyCounters = (): SlackImportCounters => ({ members: 0, messages: 0, threadReplies: 0, reactions: 0, pins: 0, files: 0, filesSkipped: 0 });

export function createSlackImportSim({ authors, clock = () => Date.now(), onDone }: SlackImportSimOptions) {
  const jobs = new Map<string, SimJob>();
  let seq = 0;
  const iso = () => new Date(clock()).toISOString();
  const channelOf = (slackId: string) => DEMO_SLACK_CHANNELS.find((c) => c.id === slackId)!;

  const newJob = (c: SlackChannelSeed): SimJob => {
    const now = iso();
    return {
      cursor: 0,
      parkedUntil: 0,
      job: {
        id: `sij_demo_${++seq}`,
        slackChannelId: c.id,
        slackChannelName: c.name,
        isPrivate: c.isPrivate,
        dubChannelId: dubChannelIdFor(c.id),
        status: "queued",
        phase: "users",
        counters: emptyCounters(),
        pending: { threads: 0, files: 0 },
        error: null,
        retryAfterMs: 0,
        createdBy: authors.me,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
      },
    };
  };
  const wire = (s: SimJob): SlackImportJob => ({
    ...s.job,
    counters: { ...s.job.counters },
    pending: { ...s.job.pending },
    retryAfterMs: s.job.status === "running" ? Math.max(0, s.parkedUntil - clock()) : 0,
  });

  // Seed history: design-review was imported before; sponsor-private failed because
  // LMB had not been invited (再開 succeeds in the demo = "invited since").
  {
    const done = newJob(channelOf("C04DESIGN"));
    done.cursor = SCRIPT.length;
    done.job = { ...done.job, status: "done", phase: "done", counters: { ...FINAL }, finishedAt: done.job.createdAt };
    jobs.set(done.job.id, done);
    onDone(importedChannelContent(channelOf("C04DESIGN"), authors, clock()), wire(done));
    const failed = newJob(channelOf("G05SPONSOR"));
    failed.job = { ...failed.job, status: "failed", error: { code: "not_in_channel", message: JOB_ERROR_MESSAGES.not_in_channel! } };
    jobs.set(failed.job.id, failed);
  }

  const bySlackId = (slackId: string) => [...jobs.values()].find((s) => s.job.slackChannelId === slackId);

  return {
    listChannels(): SlackChannelOption[] {
      return DEMO_SLACK_CHANNELS.map((c) => {
        const s = bySlackId(c.id);
        return {
          id: c.id,
          name: c.name,
          isPrivate: c.isPrivate,
          isArchived: c.isArchived,
          memberCount: c.memberCount,
          job: s ? { id: s.job.id, status: s.job.status } : null,
        };
      }).sort((a, b) => Number(a.isArchived) - Number(b.isArchived) || a.name.localeCompare(b.name));
    },
    listJobs(limit = 20): SlackImportJob[] {
      return [...jobs.values()]
        .map(wire)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
        .slice(0, Math.min(Math.max(1, limit), 50));
    },
    createJob(ref: unknown): SimResult<SlackImportJob> {
      const name = typeof ref === "string" ? ref.trim().replace(/^#/, "") : "";
      if (!name) return { ok: false, status: 400, code: "VALIDATION_FAILED", message: "channel is required" };
      const c = DEMO_SLACK_CHANNELS.find((x) => x.id === name) ?? DEMO_SLACK_CHANNELS.find((x) => x.name === name);
      if (!c) return { ok: false, status: 404, code: "NOT_FOUND", message: `slack_channel ${name} not found` };
      const existing = bySlackId(c.id);
      if (existing) {
        if (existing.job.status === "failed") {
          existing.job = { ...existing.job, status: "queued", error: null, updatedAt: iso() };
        } else if (existing.job.status === "done") {
          existing.cursor = 0;
          existing.parkedUntil = 0;
          existing.job = { ...existing.job, status: "queued", phase: "users", counters: emptyCounters(), finishedAt: null, updatedAt: iso() };
        }
        return { ok: true, status: 200, value: wire(existing) };
      }
      const created = newJob(c);
      jobs.set(created.job.id, created);
      return { ok: true, status: 201, value: wire(created) };
    },
    getJob(id: string): SimResult<SlackImportJob> {
      const s = jobs.get(id);
      return s ? { ok: true, status: 200, value: wire(s) } : { ok: false, status: 404, code: "NOT_FOUND", message: `slack_import_job ${id} not found` };
    },
    step(id: string): SimResult<SlackImportJob> {
      const s = jobs.get(id);
      if (!s) return { ok: false, status: 404, code: "NOT_FOUND", message: `slack_import_job ${id} not found` };
      if (s.job.status === "done" || s.job.status === "failed" || clock() < s.parkedUntil) return { ok: true, status: 200, value: wire(s) };
      const step = SCRIPT[s.cursor];
      s.cursor += 1;
      const now = iso();
      if (!step) return { ok: true, status: 200, value: wire(s) };
      if (step.kind === "rateLimit") {
        s.parkedUntil = clock() + step.waitMs;
        s.job = { ...s.job, status: "running", updatedAt: now };
        return { ok: true, status: 200, value: wire(s) };
      }
      const counters = { ...s.job.counters };
      for (const [k, v] of Object.entries(step.add) as [keyof SlackImportCounters, number][]) counters[k] += v;
      const done = step.to === "done";
      s.job = {
        ...s.job,
        status: done ? "done" : "running",
        phase: step.to,
        counters,
        pending: step.pending ?? { threads: 0, files: 0 },
        updatedAt: now,
        finishedAt: done ? now : null,
      };
      if (done) onDone(importedChannelContent(channelOf(s.job.slackChannelId), authors, clock()), wire(s));
      return { ok: true, status: 200, value: wire(s) };
    },
  };
}

export type SlackImportSim = ReturnType<typeof createSlackImportSim>;
