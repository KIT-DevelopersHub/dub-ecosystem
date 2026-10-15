// Slack history -> Dub fe6-chat (D1) importer — pure mapping/SQL-building layer.
// (方式A: Slack Web API → パース/マッピング → dub-core D1 直INSERT。chat-service の公開API
// は経由しない=通知の暴発や既存の楽観ロック/イベント発火を避けるオフライン専用インポーター。)
//
// This module is network/filesystem-free and fully unit-testable. It owns:
//  - Slack API response shapes (subset actually used)
//  - user/channel/message/reaction/pin/bookmark/attachment -> dub row mapping
//  - Slack mrkdwn -> dub's Markdown-subset body conversion
//  - idempotent SQL generation (literal-escaped — same style as infra/d1/src/adminNotify.ts,
//    since the apply path is `wrangler d1 execute --file`, which has no bound params)
//
// Idempotency: every dub id is DERIVED from the Slack id (see slackId below), so the same
// Slack message always maps to the same dub row and `INSERT OR IGNORE` alone makes a
// re-run (or a re-applied / partially-applied batch) a no-op. No local state file needed.
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Slack API shapes (subset)
// ---------------------------------------------------------------------------

export interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: {
    email?: string;
    real_name?: string;
    display_name?: string;
  };
}

export interface SlackChannel {
  id: string;
  name: string;
  created?: number; // epoch seconds
  is_private?: boolean;
  is_member?: boolean;
  is_archived?: boolean;
  topic?: { value?: string };
  purpose?: { value?: string };
  creator?: string; // Slack user id
}

export interface SlackReaction {
  name: string; // shortcode without colons, e.g. "thumbsup", "+1::skin-tone-2"
  users: string[]; // Slack user ids
}

export interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  mode?: string; // "tombstone" / "hidden_by_limit" (free plan) have no body
  url_private?: string; // requires Authorization: Bearer <token> to download
}

export interface SlackLegacyAttachment {
  fallback?: string;
  pretext?: string;
  title?: string;
  title_link?: string;
  text?: string;
}

export interface SlackMessage {
  ts: string; // "1699999999.000100" — Slack timestamp, unique within a channel
  user?: string;
  bot_id?: string;
  bot_profile?: { name?: string };
  username?: string; // bot_message display name
  subtype?: string; // e.g. "channel_join", "bot_message"
  text: string; // raw Slack mrkdwn
  thread_ts?: string; // present on both the root (== ts) and every reply
  reply_count?: number;
  edited?: { ts: string };
  pinned_to?: string[]; // channel ids this message is pinned in
  reactions?: SlackReaction[];
  files?: SlackFile[];
  attachments?: SlackLegacyAttachment[];
}

export interface SlackBookmark {
  id: string;
  title: string;
  link?: string;
  emoji?: string;
  type?: string;
}

// ---------------------------------------------------------------------------
// Deterministic id minting
// ---------------------------------------------------------------------------
//
// Same shape as packages/db `newId` (`<prefix>_<10 time chars><16 chars>`), but the
// trailing 16 chars come from sha256(seed) instead of randomness. The time component is
// the Slack timestamp, so `ORDER BY id DESC` (chat_messages' actual index) reproduces
// true chronological order even though rows are inserted long after the fact.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(ms: number): string {
  let out = "";
  let t = Math.max(0, Math.floor(ms));
  for (let i = 0; i < 10; i++) {
    const mod = t % 32;
    out = CROCKFORD[mod]! + out;
    t = (t - mod) / 32;
  }
  return out;
}

export function slackId(prefix: string, atMs: number, seed: string): string {
  const digest = createHash("sha256").update(`slack-import:${prefix}:${seed}`).digest();
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[digest[i]! % 32]!;
  return `${prefix}_${encodeTime(atMs)}${rand}`;
}

/** Slack ts ("1699999999.000100") -> epoch milliseconds. */
export function slackTsToMs(ts: string): number {
  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) throw new Error(`slackTsToMs: invalid Slack ts "${ts}"`);
  return Math.round(seconds * 1000);
}

export const messageIdFor = (slackChannelId: string, ts: string): string =>
  slackId("msg", slackTsToMs(ts), `${slackChannelId}:${ts}`);

export const channelIdFor = (c: SlackChannel): string => slackId("chan", (c.created ?? 0) * 1000, c.id);

export const fileIdFor = (slackFileId: string, ts: string): string => slackId("file", slackTsToMs(ts), slackFileId);

/** Placeholder identity for a Slack author with no Dub account. `key` is the Slack user
 *  id (U…) or, for app/bot posts without a user, the bot id (B…). */
export const placeholderUserIdFor = (key: string): string => slackId("usr", 0, key);

/** Deterministic email so a re-run joins the placeholder back by email (UNIQUE(org_id,email))
 *  instead of minting a second one. `.invalid` is reserved (RFC 2606): never deliverable. */
export const placeholderEmailFor = (key: string): string => `slack-${key.toLowerCase()}@slack-import.invalid`;

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

export function lit(v: string | null): string {
  if (v === null) return "NULL";
  return `'${v.replace(/'/g, "''")}'`;
}

function insertOrIgnore(table: string, cols: readonly string[], vals: readonly string[]): string {
  return `INSERT OR IGNORE INTO ${table} (${cols.join(", ")})\nVALUES (${vals.join(", ")});`;
}

// ---------------------------------------------------------------------------
// Mapping context
// ---------------------------------------------------------------------------

export interface MappingContext {
  /** Slack user/bot id -> Dub identity_users.id. Covers EVERY author/reactor: real
   *  accounts (email join) and disabled placeholders alike. */
  slackUserIdToDubUserId: ReadonlyMap<string, string>;
  /** Slack user/bot id -> display name (for system lines like joins). */
  slackUserIdToDisplayName: ReadonlyMap<string, string>;
  /** Slack channel id -> channel name, used to render `<#C…>` as plain "#name". */
  slackChannelIdToName: ReadonlyMap<string, string>;
  /** created_by / owner fallback when nothing better is known (the operator). */
  systemUserId: string;
}

/** The Slack-side author key of a message: the user id, or the bot id for app posts. */
export function authorKeyOf(m: SlackMessage): string | undefined {
  return m.user ?? m.bot_id;
}

// ---------------------------------------------------------------------------
// Placeholder users (退職者・ゲスト・bot) — status='disabled' so they cannot sign in and
// never show up in mention search (fe6-chat searches status=active only), but their
// display name still resolves on every historical message.
// ---------------------------------------------------------------------------

export interface PlaceholderUserRow {
  id: string;
  orgId: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export function placeholderDisplayName(name: string, isBot: boolean): string {
  return isBot ? `${name} (bot)` : name;
}

export function buildInsertPlaceholderUserSql(row: PlaceholderUserRow): string {
  return insertOrIgnore(
    "identity_users",
    ["id", "org_id", "email", "display_name", "status", "created_at", "updated_at"],
    [lit(row.id), lit(row.orgId), lit(row.email), lit(row.displayName), lit("disabled"), lit(row.createdAt), lit(row.createdAt)],
  );
}

// ---------------------------------------------------------------------------
// Body conversion — Slack mrkdwn -> dub's Markdown-subset (apps/fe6-chat/src/lib/render-body.ts)
// ---------------------------------------------------------------------------
//
// Shared surface (no conversion needed): *bold* _italic_ ~strike~ `code` ``` > quote.
//   <@U0123> / <@U0123|x> -> <@dubUserId>
//   <#C0123|name>         -> #name
//   <!here> etc.          -> @here
//   <https://x|label>     -> [label](https://x)
//   &amp; &lt; &gt;       -> & < >

const SLACK_TOKEN_RE = /<([^>]+)>/g;

function decodeSlackEntities(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function convertToken(token: string, ctx: MappingContext): string {
  if (token.startsWith("@")) {
    const [slackUserId, label] = token.slice(1).split("|");
    const dubUserId = ctx.slackUserIdToDubUserId.get(slackUserId ?? "");
    if (dubUserId) return `<@${dubUserId}>`;
    return `@${label ?? ctx.slackUserIdToDisplayName.get(slackUserId ?? "") ?? slackUserId}`;
  }
  if (token.startsWith("#")) {
    const [rawId, labelPart] = token.slice(1).split("|");
    return `#${labelPart || ctx.slackChannelIdToName.get(rawId ?? "") || rawId || "channel"}`;
  }
  if (token.startsWith("!")) {
    const [special, label] = token.slice(1).split("|");
    if (special?.startsWith("subteam^")) return label ?? "@group";
    if (special?.startsWith("date^")) return label ?? special;
    return `@${special}`;
  }
  const bar = token.indexOf("|");
  const url = bar >= 0 ? token.slice(0, bar) : token;
  const label = bar >= 0 ? token.slice(bar + 1) : token;
  if (/^(https?:\/\/|mailto:)/i.test(url)) return `[${label}](${url})`;
  return `<${token}>`;
}

export function convertSlackBodyToDubBody(text: string, ctx: MappingContext): string {
  return decodeSlackEntities(text.replace(SLACK_TOKEN_RE, (_m, inner: string) => convertToken(inner, ctx)));
}

/** Legacy `attachments` (bot posts / unfurl cards) carry content that `text` may lack.
 *  Rendered as quoted lines under the body so nothing the bot said is lost. */
function legacyAttachmentLines(atts: readonly SlackLegacyAttachment[] | undefined, ctx: MappingContext): string[] {
  const out: string[] = [];
  for (const a of atts ?? []) {
    const title = a.title ? (a.title_link ? `[${a.title}](${a.title_link})` : `*${a.title}*`) : "";
    const parts = [a.pretext, title, a.text].filter((s): s is string => !!s?.trim());
    const content = parts.length > 0 ? parts.join("\n") : (a.fallback ?? "");
    if (!content.trim()) continue;
    out.push(...convertSlackBodyToDubBody(content, ctx).split("\n").map((l) => `> ${l}`));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reaction emoji — Slack shortcodes -> the unicode glyph fe6-chat renders directly.
// Shortcodes outside this map (workspace custom emoji, rare glyphs) are imported as the
// literal ":name:" so the reaction and who reacted are never dropped.
// ---------------------------------------------------------------------------

export const SLACK_SHORTCODE_TO_EMOJI: Readonly<Record<string, string>> = {
  "+1": "👍", thumbsup: "👍", "-1": "👎", thumbsdown: "👎", ok_hand: "👌", clap: "👏",
  pray: "🙏", raised_hands: "🙌", wave: "👋", muscle: "💪", point_up: "☝️", point_right: "👉",
  point_left: "👈", point_down: "👇", v: "✌️", handshake: "🤝", writing_hand: "✍️", bow: "🙇",
  raising_hand: "🙋", ok_woman: "🙆", no_good: "🙅", man_bowing: "🙇‍♂️", woman_bowing: "🙇‍♀️",
  heart: "❤️", orange_heart: "🧡", yellow_heart: "💛", green_heart: "💚", blue_heart: "💙",
  purple_heart: "💜", black_heart: "🖤", white_heart: "🤍", sparkling_heart: "💖", two_hearts: "💕",
  heart_eyes: "😍", smiling_face_with_3_hearts: "🥰", kissing_heart: "😘",
  smile: "😄", smiley: "😃", grinning: "😀", grin: "😁", laughing: "😆", satisfied: "😆",
  sweat_smile: "😅", joy: "😂", rolling_on_the_floor_laughing: "🤣", slightly_smiling_face: "🙂",
  upside_down_face: "🙃", wink: "😉", blush: "😊", innocent: "😇", relaxed: "☺️", yum: "😋",
  sunglasses: "😎", nerd_face: "🤓", star_struck: "🤩", partying_face: "🥳", smirk: "😏",
  thinking_face: "🤔", face_with_monocle: "🧐", neutral_face: "😐", expressionless: "😑",
  no_mouth: "😶", face_with_rolling_eyes: "🙄", grimacing: "😬", relieved: "😌", pensive: "😔",
  sleepy: "😪", sleeping: "😴", zany_face: "🤪", hugging_face: "🤗", shushing_face: "🤫",
  hand_over_mouth: "🤭", face_with_hand_over_mouth: "🤭", saluting_face: "🫡", melting_face: "🫠",
  confused: "😕", worried: "😟", slightly_frowning_face: "🙁", open_mouth: "😮", hushed: "😯",
  astonished: "😲", flushed: "😳", pleading_face: "🥺", cry: "😢", sob: "😭", scream: "😱",
  confounded: "😖", persevere: "😣", disappointed: "😞", sweat: "😓", weary: "😩", tired_face: "😫",
  triumph: "😤", rage: "😡", angry: "😠", exploding_head: "🤯", cold_sweat: "😰", fearful: "😨",
  skull: "💀", ghost: "👻", robot_face: "🤖", see_no_evil: "🙈", hear_no_evil: "🙉", speak_no_evil: "🙊",
  eyes: "👀", eye: "👁️", brain: "🧠", fire: "🔥", sparkles: "✨", star: "⭐", star2: "🌟",
  dizzy: "💫", boom: "💥", zap: "⚡", 100: "💯", tada: "🎉", confetti_ball: "🎊", gift: "🎁",
  balloon: "🎈", trophy: "🏆", medal: "🏅", first_place_medal: "🥇", crown: "👑", gem: "💎",
  rocket: "🚀", bulb: "💡", memo: "📝", pencil: "📝", pencil2: "✏️", pushpin: "📌",
  round_pushpin: "📍", paperclip: "📎", link: "🔗", calendar: "📆", date: "📅", clock: "🕐",
  hourglass: "⌛", hourglass_flowing_sand: "⏳", alarm_clock: "⏰", bell: "🔔", mega: "📣",
  loudspeaker: "📢", email: "📧", envelope: "✉️", inbox_tray: "📥", outbox_tray: "📤",
  package: "📦", computer: "💻", iphone: "📱", camera: "📷", mag: "🔍", lock: "🔒", key: "🔑",
  hammer_and_wrench: "🛠️", wrench: "🔧", gear: "⚙️", bug: "🐛", chart_with_upwards_trend: "📈",
  bar_chart: "📊", clipboard: "📋", books: "📚", book: "📖", bookmark: "🔖", label: "🏷️",
  moneybag: "💰", coffee: "☕", tea: "🍵", beer: "🍺", beers: "🍻", pizza: "🍕", sushi: "🍣",
  cake: "🍰", birthday: "🎂", rice_ball: "🍙", ramen: "🍜", apple: "🍎", cherry_blossom: "🌸",
  sunflower: "🌻", seedling: "🌱", four_leaf_clover: "🍀", sunny: "☀️", rainbow: "🌈",
  umbrella: "☔", snowflake: "❄️", cat: "🐱", dog: "🐶", panda_face: "🐼", bear: "🐻",
  rabbit: "🐰", tiger: "🐯", penguin: "🐧", turtle: "🐢", snail: "🐌", tada_animated: "🎉",
  white_check_mark: "✅", heavy_check_mark: "✔️", ballot_box_with_check: "☑️", x: "❌",
  negative_squared_cross_mark: "❎", heavy_multiplication_x: "✖️", o: "⭕", warning: "⚠️",
  no_entry: "⛔", no_entry_sign: "🚫", question: "❓", grey_question: "❔", exclamation: "❗",
  grey_exclamation: "❕", bangbang: "‼️", interrobang: "⁉️", heavy_plus_sign: "➕",
  heavy_minus_sign: "➖", arrow_right: "➡️", arrow_left: "⬅️", arrow_up: "⬆️", arrow_down: "⬇️",
  arrows_counterclockwise: "🔄", repeat: "🔁", new: "🆕", ok: "🆗", up: "🆙", cool: "🆒",
  sos: "🆘", red_circle: "🔴", large_blue_circle: "🔵", large_green_circle: "🟢",
  large_yellow_circle: "🟡", white_circle: "⚪", black_circle: "⚫", checkered_flag: "🏁",
  triangular_flag_on_post: "🚩", flag_jp: "🇯🇵", jp: "🇯🇵", japan: "🗾", man_dancing: "🕺",
  dancer: "💃", running: "🏃", walking: "🚶", zzz: "💤", sweat_drops: "💦", dash: "💨",
  speech_balloon: "💬", thought_balloon: "💭", koko: "🈁", sa: "🈂️", u5408: "🈴", u7a7a: "🈳",
  accept: "🉑", ideograph_advantage: "🉐", congratulations: "㊗️", secret: "㊙️",
};

const SKIN_TONE: Readonly<Record<string, string>> = {
  "skin-tone-2": "🏻", "skin-tone-3": "🏼", "skin-tone-4": "🏽", "skin-tone-5": "🏾", "skin-tone-6": "🏿",
};

/** Slack reaction name -> the stored `chat_reactions.emoji` string. Never null. */
export function resolveEmoji(slackName: string): string {
  const [base = slackName, tone] = slackName.split("::");
  const glyph = SLACK_SHORTCODE_TO_EMOJI[base];
  if (!glyph) return `:${slackName}:`;
  return tone && SKIN_TONE[tone] ? glyph.replace(/️$/, "") + SKIN_TONE[tone] : glyph;
}

// ---------------------------------------------------------------------------
// Channel + members
// ---------------------------------------------------------------------------

export interface ChannelInsertRow {
  id: string;
  visibility: "public" | "private";
  name: string;
  topic: string | null;
  createdBy: string;
  createdAt: string;
  archivedAt: string | null;
}

export function buildChannelRow(slack: SlackChannel, ctx: MappingContext, nowIso: string): ChannelInsertRow {
  const topic = slack.topic?.value?.trim() || slack.purpose?.value?.trim() || null;
  return {
    id: channelIdFor(slack),
    visibility: slack.is_private ? "private" : "public",
    name: slack.name,
    topic,
    createdBy: (slack.creator && ctx.slackUserIdToDubUserId.get(slack.creator)) || ctx.systemUserId,
    createdAt: slack.created ? new Date(slack.created * 1000).toISOString() : nowIso,
    archivedAt: slack.is_archived ? nowIso : null,
  };
}

export function buildInsertChannelSql(row: ChannelInsertRow): string {
  return insertOrIgnore(
    "chat_channels",
    ["id", "type", "visibility", "name", "topic", "event_id", "dm_key", "created_by", "archived_at", "version", "created_at", "updated_at"],
    [
      lit(row.id), lit("topic"), lit(row.visibility), lit(row.name), lit(row.topic), "NULL", "NULL",
      lit(row.createdBy), lit(row.archivedAt), "1", lit(row.createdAt), lit(row.createdAt),
    ],
  );
}

export function buildInsertMemberSql(channelId: string, userId: string, role: "admin" | "member", joinedAt: string): string {
  return insertOrIgnore(
    "chat_channel_members",
    ["channel_id", "user_id", "role", "joined_at"],
    [lit(channelId), lit(userId), lit(role), lit(joinedAt)],
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface MessageInsertRow {
  id: string;
  channelId: string;
  threadRootId: string | null;
  authorId: string | null;
  kind: "user" | "system";
  body: string;
  attachmentFileIds: string[];
  editedAt: string | null;
  createdAt: string;
}

const SYSTEM_SUBTYPES: Readonly<Record<string, string>> = {
  channel_join: "がチャンネルに参加しました",
  channel_leave: "がチャンネルから退出しました",
};

export interface BuildMessageOptions {
  slack: SlackMessage;
  slackChannelId: string;
  dubChannelId: string;
  ctx: MappingContext;
  attachmentFileIds?: string[];
}

export function buildMessageRow(opts: BuildMessageOptions): MessageInsertRow {
  const { slack, slackChannelId, dubChannelId, ctx } = opts;
  const key = authorKeyOf(slack);
  const authorId = (key && ctx.slackUserIdToDubUserId.get(key)) || null;
  const isReply = !!slack.thread_ts && slack.thread_ts !== slack.ts;

  const systemSuffix = slack.subtype ? SYSTEM_SUBTYPES[slack.subtype] : undefined;
  let kind: "user" | "system" = "user";
  let body: string;
  if (systemSuffix) {
    kind = "system";
    body = `${(key && ctx.slackUserIdToDisplayName.get(key)) || "メンバー"} ${systemSuffix}`;
  } else {
    const lines = [convertSlackBodyToDubBody(slack.text ?? "", ctx), ...legacyAttachmentLines(slack.attachments, ctx)];
    body = lines.filter((l) => l.length > 0).join("\n");
  }

  return {
    id: messageIdFor(slackChannelId, slack.ts),
    channelId: dubChannelId,
    threadRootId: isReply ? messageIdFor(slackChannelId, slack.thread_ts!) : null,
    authorId: kind === "system" ? null : authorId,
    kind,
    body,
    attachmentFileIds: opts.attachmentFileIds ?? [],
    editedAt: slack.edited?.ts ? new Date(slackTsToMs(slack.edited.ts)).toISOString() : null,
    createdAt: new Date(slackTsToMs(slack.ts)).toISOString(),
  };
}

export function buildInsertMessageSql(row: MessageInsertRow): string {
  return insertOrIgnore(
    "chat_messages",
    ["id", "channel_id", "thread_root_id", "author_id", "kind", "body", "attachment_file_ids", "version", "edited_at", "deleted_at", "created_at"],
    [
      lit(row.id), lit(row.channelId), lit(row.threadRootId), lit(row.authorId), lit(row.kind), lit(row.body),
      lit(JSON.stringify(row.attachmentFileIds)), "1", lit(row.editedAt), "NULL", lit(row.createdAt),
    ],
  );
}

// ---------------------------------------------------------------------------
// Reactions + pins
// ---------------------------------------------------------------------------

export interface ReactionInsertRow {
  messageId: string;
  emoji: string;
  userId: string;
  createdAt: string;
}

/** Slack exposes no per-user reaction time, so each reaction carries the message's time. */
export function buildReactionRows(slack: SlackMessage, dubMessageId: string, messageCreatedAt: string, ctx: MappingContext): ReactionInsertRow[] {
  const rows: ReactionInsertRow[] = [];
  for (const r of slack.reactions ?? []) {
    const emoji = resolveEmoji(r.name);
    for (const slackUserId of r.users) {
      const userId = ctx.slackUserIdToDubUserId.get(slackUserId);
      if (userId) rows.push({ messageId: dubMessageId, emoji, userId, createdAt: messageCreatedAt });
    }
  }
  return rows;
}

export function buildInsertReactionSql(row: ReactionInsertRow): string {
  return insertOrIgnore(
    "chat_reactions",
    ["message_id", "emoji", "user_id", "created_at"],
    [lit(row.messageId), lit(row.emoji), lit(row.userId), lit(row.createdAt)],
  );
}

export function buildInsertPinSql(channelId: string, messageId: string, pinnedBy: string, pinnedAt: string): string {
  return insertOrIgnore("chat_pins", ["channel_id", "message_id", "pinned_by", "pinned_at"], [lit(channelId), lit(messageId), lit(pinnedBy), lit(pinnedAt)]);
}

// ---------------------------------------------------------------------------
// Bookmarks — dub has no bookmark bar, so a channel's Slack bookmarks become ONE pinned
// system message listing them (Slack's closest analogue in fe6-chat: the pins panel).
// Upserted on re-run so added/removed bookmarks are reflected.
// ---------------------------------------------------------------------------

/** Anchored at the channel's creation time so it sits at the very start of the history. */
export function bookmarkMessageIdFor(channel: SlackChannel): string {
  return slackId("msg", (channel.created ?? 0) * 1000, `${channel.id}:bookmarks`);
}

export function buildBookmarkBody(bookmarks: readonly SlackBookmark[]): string | null {
  const lines = bookmarks
    .filter((b) => b.link)
    .map((b) => `- ${b.emoji ? `${resolveEmoji(b.emoji.replace(/:/g, ""))} ` : ""}[${b.title || b.link}](${b.link})`);
  if (lines.length === 0) return null;
  return ["*Slack のブックマーク*", ...lines].join("\n");
}

export function buildUpsertBookmarkSqls(channel: SlackChannel, dubChannelId: string, body: string, pinnedBy: string, nowIso: string): string[] {
  const id = bookmarkMessageIdFor(channel);
  const createdAt = channel.created ? new Date(channel.created * 1000).toISOString() : nowIso;
  return [
    `INSERT INTO chat_messages (id, channel_id, thread_root_id, author_id, kind, body, attachment_file_ids, version, edited_at, deleted_at, created_at)\n` +
      `VALUES (${lit(id)}, ${lit(dubChannelId)}, NULL, NULL, 'system', ${lit(body)}, '[]', 1, NULL, NULL, ${lit(createdAt)})\n` +
      `ON CONFLICT(id) DO UPDATE SET body = excluded.body WHERE chat_messages.body <> excluded.body;`,
    buildInsertPinSql(dubChannelId, id, pinnedBy, nowIso),
  ];
}

// ---------------------------------------------------------------------------
// Attachments — file_meta_files (source=r2) + file_meta_links (target_type='message')
// ---------------------------------------------------------------------------

export const R2_ATTACHMENT_BUCKET = "dub-file-attachments";

/** Files Slack will not serve (deleted, or beyond the free plan's visible window). */
export function isDownloadable(file: SlackFile): boolean {
  return !!file.url_private && file.mode !== "tombstone" && file.mode !== "hidden_by_limit";
}

export function fileNameOf(file: SlackFile): string {
  return file.name || file.title || file.id;
}

/** Deterministic R2 key — stable across re-runs, so a repeat --apply overwrites in place. */
export function r2KeyForSlackFile(slackChannelId: string, ts: string, file: SlackFile): string {
  return `slack-import/${slackChannelId}/${ts}/${file.id}-${fileNameOf(file)}`;
}

export interface FileMetaInsertRow {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  ownerId: string;
  r2Key: string;
  createdAt: string;
}

export function buildFileMetaRow(file: SlackFile, slackChannelId: string, ts: string, ownerId: string): FileMetaInsertRow {
  return {
    id: fileIdFor(file.id, ts),
    name: fileNameOf(file),
    mimeType: file.mimetype ?? "application/octet-stream",
    sizeBytes: file.size ?? 0,
    ownerId,
    r2Key: r2KeyForSlackFile(slackChannelId, ts, file),
    createdAt: new Date(slackTsToMs(ts)).toISOString(),
  };
}

export function buildInsertFileMetaSql(row: FileMetaInsertRow): string {
  return insertOrIgnore(
    "file_meta_files",
    ["id", "name", "mime_type", "size_bytes", "owner_id", "visibility", "drive_file_id", "r2_key", "archived_at", "created_by", "created_at", "updated_at"],
    [
      lit(row.id), lit(row.name), lit(row.mimeType), String(row.sizeBytes), lit(row.ownerId), lit("org"), "NULL",
      lit(row.r2Key), "NULL", lit(row.ownerId), lit(row.createdAt), lit(row.createdAt),
    ],
  );
}

export function buildInsertFileLinkSql(fileId: string, dubMessageId: string, linkedBy: string, linkedAt: string): string {
  return insertOrIgnore(
    "file_meta_links",
    ["file_id", "target_type", "target_id", "linked_by", "linked_at", "archived_at"],
    [lit(fileId), lit("message"), lit(dubMessageId), lit(linkedBy), lit(linkedAt), "NULL"],
  );
}

// ---------------------------------------------------------------------------
// Summary + batching
// ---------------------------------------------------------------------------

export interface ImportSummary {
  channels: number;
  members: number;
  placeholderUsers: number;
  messages: number;
  threadReplies: number;
  reactions: number;
  customEmojiReactions: number; // stored as literal ":name:" (no unicode glyph)
  pins: number;
  bookmarks: number;
  attachments: number;
  attachmentsUnavailable: number; // deleted / hidden by the free plan limit
  estimatedStatements: number;
}

export function emptySummary(): ImportSummary {
  return {
    channels: 0, members: 0, placeholderUsers: 0, messages: 0, threadReplies: 0, reactions: 0,
    customEmojiReactions: 0, pins: 0, bookmarks: 0, attachments: 0, attachmentsUnavailable: 0, estimatedStatements: 0,
  };
}

/** Split statements into batches so one `wrangler d1 execute --file` stays small. */
export function batchStatements(statements: readonly string[], maxPerBatch = 200): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < statements.length; i += maxPerBatch) out.push(statements.slice(i, i + maxPerBatch));
  return out;
}
