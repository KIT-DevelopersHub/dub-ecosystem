// Demo seed for standalone dev + tests. A populated "workspace": several members
// with presence, public channels + an event channel + DMs, threaded replies,
// reactions, mentions and a code block — so the mock server renders like a real
// Slack-style workspace out of the box.
import type { identity } from "@dub/types";
import type { Channel, ChannelMember, Message, Reaction } from "../api/contract";
import type { MockSeed } from "../api/mock-client";
import { setPresence } from "../lib/presence";

// day = Aug 2026; helper builds an ISO timestamp for hour h, minute m.
const t = (day: number, h: number, m: number): string => new Date(Date.UTC(2026, 7, day, h, m, 0)).toISOString();

export const ME = "usr_me0000000000000000000000";
export const HANAKO = "usr_hanako00000000000000000";
export const DAISUKE = "usr_daisuke0000000000000000";
export const MISAKI = "usr_misaki00000000000000000";
export const KENICHI = "usr_kenichi0000000000000000";
export const BOT = "usr_bot0000000000000000000x";
// Back-compat alias for existing tests that import OTHER.
export const OTHER = HANAKO;

const users: identity.UserSummary[] = [
  { id: ME, displayName: "高岡 己太朗", avatarUrl: null },
  { id: HANAKO, displayName: "佐藤 花子", avatarUrl: null },
  { id: DAISUKE, displayName: "田中 大輔", avatarUrl: null },
  { id: MISAKI, displayName: "鈴木 美咲", avatarUrl: null },
  { id: KENICHI, displayName: "山本 健一", avatarUrl: null },
  { id: BOT, displayName: "DevHub Bot", avatarUrl: null },
];

// channel ids
const C_GENERAL = "chn_general00000000000000000";
const C_RANDOM = "chn_random000000000000000000";
const C_DEV = "chn_dev00000000000000000000x";
const C_DESIGN = "chn_design0000000000000000x0";
const C_CONF = "chn_conf0000000000000000000x";
const C_DM_HANAKO = "chn_dmhanako0000000000000000";
const C_DM_KENICHI = "chn_dmkenichi000000000000000";
const C_ARCHIVED = "chn_archived0000000000000000";

const ch = (over: Partial<Channel> & Pick<Channel, "id" | "type" | "name">): Channel => ({
  orgId: "org_devhub",
  visibility: "public",
  topic: null,
  eventId: null,
  archived: false,
  memberCount: 6,
  version: 1,
  createdAt: t(1, 0, 0),
  updatedAt: t(1, 0, 0),
  ...over,
});

const channels: Channel[] = [
  ch({ id: C_GENERAL, type: "topic", name: "general", topic: "全体連絡・お知らせ 📣" }),
  ch({ id: C_RANDOM, type: "topic", name: "random", topic: "雑談なんでも" }),
  ch({ id: C_DEV, type: "topic", name: "dev", topic: "開発・デプロイ・レビュー" }),
  ch({ id: C_DESIGN, type: "topic", visibility: "private", name: "design", topic: "UI/UX・デザインレビュー", memberCount: 4 }),
  ch({ id: C_CONF, type: "event", name: "北陸itカンファレンス", topic: "運営チャネル", eventId: "evt_conf000000000000000000", memberCount: 5 }),
  ch({ id: C_DM_HANAKO, type: "dm", name: "佐藤 花子", memberCount: 2 }),
  ch({ id: C_DM_KENICHI, type: "dm", name: "山本 健一", memberCount: 2 }),
  ch({ id: C_ARCHIVED, type: "topic", name: "old-topic", archived: true, memberCount: 1, version: 2 }),
];

const react = (emoji: string, ...userIds: string[]): Reaction => ({ emoji, userIds });

// message ids are ULID-like and sort lexicographically → chronological.
const m = (
  id: string,
  channelId: string,
  authorId: string,
  body: string,
  createdAt: string,
  over: Partial<Message> = {},
): Message => ({
  id,
  channelId,
  authorId,
  body,
  threadRootId: null,
  replyCount: 0,
  reactions: [],
  attachments: [],
  editedAt: null,
  deletedAt: null,
  version: 1,
  createdAt,
  ...over,
});

// NOTE on ids: they must sort *before* newly-minted ULIDs (mock ids look like
// "msg_01..."), so seed ids stay in the "msg_000.." band. Thread-reply ids must
// also stay below their channel's newest *top-level* id, so that marking the
// channel read (to that top-level id) clears unread including the replies.
const THREAD_ROOT = "msg_00060_root00000000000000";

const messages: Message[] = [
  // ── #general ──────────────────────────────────────────────────────────
  m("msg_00010000000000000000000x", C_GENERAL, HANAKO, "おはようございます！今日もよろしくお願いします 🙌", t(9, 9, 2), {
    reactions: [react("👋", DAISUKE, MISAKI, ME), react("☕", KENICHI)],
  }),
  m("msg_00020000000000000000000x", C_GENERAL, BOT, "本日の予定: 10:00 スタンドアップ / 14:00 デザインレビュー", t(9, 9, 5), {
    reactions: [react("👍", ME, HANAKO)],
  }),
  m("msg_00030000000000000000000x", C_GENERAL, ME, "スタンドアップの前に `deploy` を本番へ流しました ✅", t(9, 9, 12), {
    reactions: [react("🚀", HANAKO, DAISUKE, MISAKI, KENICHI)],
  }),
  m("msg_00040000000000000000000x", C_GENERAL, KENICHI, `<@${ME}> ありがとう！ステージングの確認もお願いできますか`, t(9, 9, 20)),
  m("msg_00050000000000000000000x", C_GENERAL, ME, "了解です、これから見ます 👀", t(9, 9, 21)),
  m(THREAD_ROOT, C_GENERAL, MISAKI, "新しいロゴ案、3パターン用意しました。意見ください！", t(9, 10, 30), {
    replyCount: 3,
    reactions: [react("🎨", ME, HANAKO, DAISUKE), react("❤️", KENICHI)],
    attachments: [
      {
        fileId: "fil_logo0000000000000000000x",
        name: "logo-proposal-B.svg",
        mime: "image/svg+xml",
        size: 4213,
        // tiny inline SVG so the demo shows an inline image without a network fetch
        url:
          "data:image/svg+xml;utf8," +
          encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="120"><rect width="220" height="120" rx="12" fill="#3358e8"/><circle cx="60" cy="60" r="30" fill="#fff"/><text x="110" y="68" font-family="sans-serif" font-size="26" font-weight="700" fill="#fff">DevHub</text></svg>',
          ),
      },
    ],
  }),
  // thread replies (ids sort after the root but below the channel's newest top-level)
  m("msg_00061000000000000000000x", C_GENERAL, HANAKO, "B案がいいと思います！余白の取り方が好き", t(9, 10, 35), { threadRootId: THREAD_ROOT }),
  m("msg_00062000000000000000000x", C_GENERAL, ME, "自分もB案に一票。ダークモードでも映えそう", t(9, 10, 41), { threadRootId: THREAD_ROOT }),
  m("msg_00063000000000000000000x", C_GENERAL, DAISUKE, `<@${MISAKI}> SVGもらえれば実装側で反映します`, t(9, 10, 52), { threadRootId: THREAD_ROOT }),
  // newest top-level in #general (id above the thread replies)
  m("msg_00090000000000000000000x", C_GENERAL, HANAKO, "ロゴ決定ありがとうございます！展開しておきます 🎉", t(9, 11, 5)),

  // ── #dev ──────────────────────────────────────────────────────────────
  m("msg_00100000000000000000000x", C_DEV, DAISUKE, "APIのレート制限、こんな感じで入れました", t(9, 11, 2)),
  m(
    "msg_00110000000000000000000x",
    C_DEV,
    DAISUKE,
    "```ts\nconst limiter = rateLimit({\n  windowMs: 60_000,\n  max: 100,\n});\napp.use(limiter);\n```",
    t(9, 11, 3),
    { reactions: [react("👍", ME, MISAKI), react("🔥", HANAKO)] },
  ),
  m("msg_00120000000000000000000x", C_DEV, ME, "いいですね！`max` は環境変数にしておきましょう", t(9, 11, 8), {
    editedAt: t(9, 11, 9),
  }),
  m("msg_00130000000000000000000x", C_DEV, MISAKI, "レビュー投げました 🙏", t(9, 11, 40), { reactions: [react("✅", DAISUKE)] }),

  // ── #random ─────────────────────────────────────────────────────────────
  m("msg_00140000000000000000000x", C_RANDOM, KENICHI, "近くにいい感じのカフェ見つけた ☕️ 今度みんなで行きましょう", t(9, 12, 15), {
    reactions: [react("😋", ME, HANAKO, MISAKI)],
  }),

  // ── event: 北陸ITカンファレンス ─────────────────────────────────────────
  m("msg_00150000000000000000000x", C_CONF, HANAKO, "登壇者の確定リスト共有します。スプレッドシートは後ほど 📄", t(9, 13, 0), {
    reactions: [react("🎉", ME, DAISUKE, KENICHI)],
  }),
  m("msg_00160000000000000000000x", C_CONF, ME, `<@${HANAKO}> 助かります！会場レイアウトも詰めましょう`, t(9, 13, 5)),

  // ── DM: 佐藤 花子 ────────────────────────────────────────────────────────
  m("msg_00170000000000000000000x", C_DM_HANAKO, HANAKO, "さっきの件、資料まとめておきました！", t(9, 14, 0)),
  m("msg_00180000000000000000000x", C_DM_HANAKO, ME, "ありがとうございます、確認します 🙏", t(9, 14, 2)),
];

const members: ChannelMember[] = [
  { channelId: C_GENERAL, userId: ME, role: "admin", joinedAt: t(1, 0, 0) },
  { channelId: C_RANDOM, userId: ME, role: "member", joinedAt: t(1, 0, 0) },
  { channelId: C_DEV, userId: ME, role: "member", joinedAt: t(1, 0, 0) },
  { channelId: C_DESIGN, userId: ME, role: "member", joinedAt: t(1, 0, 0) },
  { channelId: C_CONF, userId: ME, role: "member", joinedAt: t(1, 0, 0) },
  { channelId: C_DM_HANAKO, userId: ME, role: "member", joinedAt: t(1, 0, 0) },
  { channelId: C_DM_KENICHI, userId: ME, role: "member", joinedAt: t(1, 0, 0) },
];

// presence for sidebar dots. DM entries are keyed by channel id (the sidebar row
// for a DM has no explicit peer field in the contract); member entries by userId.
setPresence({
  [HANAKO]: "online",
  [DAISUKE]: "online",
  [MISAKI]: "away",
  [KENICHI]: "offline",
  [BOT]: "online",
  [C_DM_HANAKO]: "online",
  [C_DM_KENICHI]: "offline",
});

// Pre-pin the bot's daily-schedule post so the pinned-items popover has content.
const pins = [{ channelId: C_GENERAL, messageId: "msg_00020000000000000000000x" }];

export function demoSeed(): MockSeed {
  return { currentUserId: ME, channels, messages, members, users, pins };
}
