// Slack history -> Dub fe6-chat (D1) importer — pure mapping/SQL-building layer.
// (方式A: Slack Web API → パース/マッピング → dub-core D1 直INSERT。chat-service の公開API
// は経由しない=通知の暴発や既存の楽観ロック/イベント発火を避けるオフライン専用インポーター。)
//
// This module is filesystem/network-free and fully unit-testable. It owns:
//  - Slack API response shapes (subset actually used)
//  - user/channel/message/reaction/attachment -> dub row mapping
//  - Slack mrkdwn -> dub's Markdown-subset body conversion
//  - idempotent SQL generation (INSERT OR IGNORE, literal-escaped — same style as
//    infra/d1/src/adminNotify.ts, since the apply path is `wrangler d1 execute --file`,
//    which has no bound params)
//  - the processed-ts ledger (channel+ts -> minted dub id) that makes re-running the
//    importer over the same Slack history idempotent even though id minting uses a
//    genuinely random ULID suffix (packages/db/src/ids.ts `ulid`). The ledger, not id
//    collision, is the source of truth for "already imported"; INSERT OR IGNORE is a
//    second line of defense for re-applying the exact same generated .sql file.
//  - batching (D1 free-tier write-limit friendly) + a size estimate for preview.
import { ulid } from "@dub/db";

// ---------------------------------------------------------------------------
// Slack API shapes (subset)
// ---------------------------------------------------------------------------

export interface SlackUser {
  id: string;
  team_id?: string;
  name?: string;
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
  is_private?: boolean;
  is_channel?: boolean;
  is_group?: boolean;
  is_archived?: boolean;
  topic?: { value?: string };
  creator?: string; // Slack user id
}

export interface SlackReaction {
  name: string; // shortcode without colons, e.g. "thumbsup"
  users: string[]; // Slack user ids
}

export interface SlackFile {
  id: string;
  name: string;
  mimetype?: string;
  size?: number;
  url_private?: string; // requires Authorization: Bearer <token> to download
}

export interface SlackMessage {
  ts: string; // "1699999999.000100" — Slack timestamp, also the message's stable id
  user?: string; // Slack user id (absent for some system/bot messages)
  bot_id?: string;
  subtype?: string; // e.g. "channel_join", "bot_message" — non-'user' content
  text: string; // raw Slack mrkdwn
  thread_ts?: string; // present on both the root (== ts) and every reply
  reply_count?: number;
  reactions?: SlackReaction[];
  files?: SlackFile[];
}

// ---------------------------------------------------------------------------
// Mapping context
// ---------------------------------------------------------------------------

export type UnmappedUserPolicy = "embed-name" | "skip-message";

export interface MappingContext {
  /** Slack user id -> Dub identity_users.id, built from users.list ∩ identity_users
   *  (email is the join key). Users with no email match (退職/ゲスト/bot) are absent. */
  slackUserIdToDubUserId: ReadonlyMap<string, string>;
  /** Slack user id -> display name, used when a user can't be mapped (embed-name policy)
   *  and for @mention fallback text. */
  slackUserIdToDisplayName: ReadonlyMap<string, string>;
  /** Slack channel id -> channel name, used to render `<#C…|name>` as plain "#name". */
  slackChannelIdToName: ReadonlyMap<string, string>;
  /** Fallback identity_users.id used as created_by for channels whose Slack creator is
   *  unmapped, and as file_meta_files.owner_id when a file's uploader is unmapped. */
  systemUserId: string;
  /** What to do with a message whose author has no Dub mapping. Default "embed-name":
   *  keep the message (kind='user', author_id=NULL) and prefix the body with
   *  "[Slack: <display name>] " so the historical author is not silently lost — the
   *  message just won't render as a proper chat bubble tied to a user account. This
   *  matters for 退職者/ゲスト whose Slack account will never have a Dub identity. */
  unmappedUserPolicy?: UnmappedUserPolicy;
}

export const DEFAULT_UNMAPPED_POLICY: UnmappedUserPolicy = "embed-name";

// ---------------------------------------------------------------------------
// Ledger — processed-ts registry (the actual idempotency mechanism)
// ---------------------------------------------------------------------------

export interface SlackImportLedger {
  getChannel(slackChannelId: string): string | undefined;
  setChannel(slackChannelId: string, dubChannelId: string): void;
  getMessage(slackChannelId: string, ts: string): string | undefined;
  setMessage(slackChannelId: string, ts: string, dubMessageId: string): void;
  /** Whether a file (by Slack file id) was already uploaded/registered. */
  getFile(slackFileId: string): string | undefined;
  setFile(slackFileId: string, dubFileId: string): void;
  toJSON(): SlackImportLedgerData;
}

export interface SlackImportLedgerData {
  version: 1;
  channels: Record<string, string>; // slackChannelId -> dubChannelId
  messages: Record<string, string>; // "<slackChannelId>:<ts>" -> dubMessageId
  files: Record<string, string>; // slackFileId -> dubFileId
}

function messageKey(channelId: string, ts: string): string {
  return `${channelId}:${ts}`;
}

/** In-memory ledger, seedable from a previously-persisted SlackImportLedgerData (the
 *  CLI script loads/saves this as JSON between runs — see scripts/slack-import.ts). */
export function createLedger(seed?: SlackImportLedgerData): SlackImportLedger {
  const channels = new Map<string, string>(Object.entries(seed?.channels ?? {}));
  const messages = new Map<string, string>(Object.entries(seed?.messages ?? {}));
  const files = new Map<string, string>(Object.entries(seed?.files ?? {}));
  return {
    getChannel: (id) => channels.get(id),
    setChannel: (id, dubId) => void channels.set(id, dubId),
    getMessage: (channelId, ts) => messages.get(messageKey(channelId, ts)),
    setMessage: (channelId, ts, dubId) => void messages.set(messageKey(channelId, ts), dubId),
    getFile: (id) => files.get(id),
    setFile: (id, dubId) => void files.set(id, dubId),
    toJSON: () => ({
      version: 1,
      channels: Object.fromEntries(channels),
      messages: Object.fromEntries(messages),
      files: Object.fromEntries(files),
    }),
  };
}

// ---------------------------------------------------------------------------
// id minting — Slack ts drives the ULID time component so `ORDER BY id DESC`
// (chat_messages' actual index) reproduces true chronological order even though
// rows are inserted long after the fact, in whatever order the Slack API returns.
// ---------------------------------------------------------------------------

/** Slack ts ("1699999999.000100") -> epoch milliseconds. The fractional part is real
 *  sub-second precision (microseconds since epoch), not just a disambiguator, so it is
 *  parsed as a float and rounded rather than truncated at the decimal point. */
export function slackTsToMs(ts: string): number {
  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) throw new Error(`slackTsToMs: invalid Slack ts "${ts}"`);
  return Math.round(seconds * 1000);
}

function mintId(prefix: string, atMs: number): string {
  return `${prefix}_${ulid(atMs)}`;
}

/** Mint-or-reuse the dub message id for one Slack message, consulting the ledger first
 *  (idempotency). Also records the mapping so later calls (and later runs, once the
 *  ledger is persisted) are stable. */
export function mintMessageId(ledger: SlackImportLedger, slackChannelId: string, ts: string): { id: string; isNew: boolean } {
  const existing = ledger.getMessage(slackChannelId, ts);
  if (existing) return { id: existing, isNew: false };
  const id = mintId("msg", slackTsToMs(ts));
  ledger.setMessage(slackChannelId, ts, id);
  return { id, isNew: true };
}

/** Mint-or-reuse the dub channel id for one Slack channel. Channels have no natural
 *  "creation ts" in the payload we read, so the mint uses now() like `newId` normally
 *  would — reordering channels by id is not a requirement (messages are). */
export function mintChannelId(ledger: SlackImportLedger, slackChannelId: string, atMs: number = Date.now()): { id: string; isNew: boolean } {
  const existing = ledger.getChannel(slackChannelId);
  if (existing) return { id: existing, isNew: false };
  const id = mintId("chan", atMs);
  ledger.setChannel(slackChannelId, id);
  return { id, isNew: true };
}

export function mintFileId(ledger: SlackImportLedger, slackFileId: string, atMs: number): { id: string; isNew: boolean } {
  const existing = ledger.getFile(slackFileId);
  if (existing) return { id: existing, isNew: false };
  const id = mintId("file", atMs);
  ledger.setFile(slackFileId, id);
  return { id, isNew: true };
}

// ---------------------------------------------------------------------------
// SQL literal helpers (mirrors infra/d1/src/adminNotify.ts `lit` — the apply path is
// `wrangler d1 execute --file`, which has no bound params, so literals are escaped here).
// ---------------------------------------------------------------------------

export function lit(v: string | null): string {
  if (v === null) return "NULL";
  return `'${v.replace(/'/g, "''")}'`;
}

function insertOrIgnore(table: string, cols: readonly string[], vals: readonly string[]): string {
  return `INSERT OR IGNORE INTO ${table} (${cols.join(", ")})\nVALUES (${vals.join(", ")});`;
}

// ---------------------------------------------------------------------------
// Body conversion — Slack mrkdwn -> dub's Markdown-subset (apps/fe6-chat/src/lib/render-body.ts)
// ---------------------------------------------------------------------------
//
// Shared surface (no conversion needed): *bold* _italic_ ~strike~ `code` ``` code
// block ``` > blockquote. Slack-specific tokens that DO need conversion:
//   <@U0123>            -> <@dubUserId>            (same wrapper syntax; only the id changes)
//   <@U0123|display>    -> <@dubUserId>             (labelled form; label discarded, live name is resolved client-side)
//   <#C0123|name>       -> #name                    (channel ref; dub has no channel-mention syntax)
//   <!channel> <!here> <!everyone> -> @channel / @here / @everyone (plain text)
//   <https://x|label>   -> [label](https://x)        (dub uses markdown link syntax)
//   <https://x>         -> [https://x](https://x)
//   &amp; &lt; &gt;     -> & < >                      (Slack HTML-entity-escapes literal text)

const SLACK_TOKEN_RE = /<([^>]+)>/g;

function decodeSlackEntities(text: string): string {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function convertToken(token: string, ctx: MappingContext): string {
  // token is the content between < and >, e.g. "@U0123|display", "#C0123|name", "!here",
  // "https://x|label".
  if (token.startsWith("@")) {
    const slackUserId = token.slice(1).split("|")[0]!;
    const dubUserId = ctx.slackUserIdToDubUserId.get(slackUserId);
    if (dubUserId) return `<@${dubUserId}>`;
    const name = ctx.slackUserIdToDisplayName.get(slackUserId) ?? slackUserId;
    return `@${name}`; // unmapped user: plain text, not a live mention pill
  }
  if (token.startsWith("#")) {
    const [rawId, labelPart] = token.slice(1).split("|");
    const name = labelPart ?? ctx.slackChannelIdToName.get(rawId ?? "") ?? rawId ?? "channel";
    return `#${name}`;
  }
  if (token.startsWith("!")) {
    const special = token.slice(1).split("|")[0]!;
    if (special === "channel" || special === "here" || special === "everyone") return `@${special}`;
    return `@${special}`; // unknown special mention (e.g. subteam) — best-effort passthrough
  }
  // link: "<url>" or "<url|label>"
  const bar = token.indexOf("|");
  const url = bar >= 0 ? token.slice(0, bar) : token;
  const label = bar >= 0 ? token.slice(bar + 1) : token;
  if (/^https?:\/\//i.test(url)) return `[${label}](${url})`;
  return `<${token}>`; // not a recognized Slack token shape — leave as-is
}

/** Convert one Slack message's `text` to dub's Markdown-subset body. Pure + total (never
 *  throws on malformed input — falls back to leaving unrecognized tokens untouched). */
export function convertSlackBodyToDubBody(text: string, ctx: MappingContext): string {
  const withTokens = text.replace(SLACK_TOKEN_RE, (_m, inner: string) => convertToken(inner, ctx));
  return decodeSlackEntities(withTokens);
}

// ---------------------------------------------------------------------------
// Reaction emoji — Slack reactions are shortcodes ("thumbsup"); dub renders the emoji
// character directly (apps/fe6-chat/src/components/MessageItem.tsx: `<span>{r.emoji}</span>`),
// so shortcodes must resolve to a real unicode glyph. Curated map covering the common
// Slack default reactions; anything unmapped is skipped (never imported as a bare
// ":shortcode:" string, which would render as literal text in the reaction pill).
export const SLACK_SHORTCODE_TO_EMOJI: Readonly<Record<string, string>> = {
  thumbsup: "👍",
  "+1": "👍",
  thumbsdown: "👎",
  "-1": "👎",
  heart: "❤️",
  heavy_heart_exclamation: "❤️",
  joy: "😂",
  smile: "😄",
  smiley: "😃",
  grinning: "😀",
  tada: "🎉",
  clap: "👏",
  pray: "🙏",
  fire: "🔥",
  eyes: "👀",
  thinking_face: "🤔",
  raised_hands: "🙌",
  ok_hand: "👌",
  100: "💯",
  rocket: "🚀",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  x: "❌",
  cry: "😢",
  sob: "😭",
  sweat_smile: "😅",
  wave: "👋",
  bow: "🙇",
  muscle: "💪",
  point_up: "☝️",
  bulb: "💡",
  warning: "⚠️",
  question: "❓",
  exclamation: "❗",
};

export function resolveEmoji(slackShortcode: string): string | null {
  return SLACK_SHORTCODE_TO_EMOJI[slackShortcode] ?? null;
}

// ---------------------------------------------------------------------------
// Row shapes + SQL builders
// ---------------------------------------------------------------------------

export interface ChannelInsertRow {
  id: string;
  type: "topic";
  visibility: "public" | "private";
  name: string;
  topic: string | null;
  createdBy: string;
  createdAt: string;
}

export function buildChannelRow(
  slack: SlackChannel,
  ledger: SlackImportLedger,
  ctx: MappingContext,
  createdAt: string,
): ChannelInsertRow {
  const { id } = mintChannelId(ledger, slack.id);
  const createdBy = (slack.creator && ctx.slackUserIdToDubUserId.get(slack.creator)) ?? ctx.systemUserId;
  return {
    id,
    type: "topic",
    visibility: slack.is_private ? "private" : "public",
    name: slack.name,
    topic: slack.topic?.value?.trim() ? slack.topic.value.trim() : null,
    createdBy,
    createdAt,
  };
}

export function buildInsertChannelSql(row: ChannelInsertRow): string {
  return insertOrIgnore(
    "chat_channels",
    ["id", "type", "visibility", "name", "topic", "event_id", "dm_key", "created_by", "archived_at", "version", "created_at", "updated_at"],
    [
      lit(row.id),
      lit(row.type),
      lit(row.visibility),
      lit(row.name),
      lit(row.topic),
      "NULL", // event_id — Slack import has no event association by default
      "NULL", // dm_key — DMs are out of scope for this importer
      lit(row.createdBy),
      "NULL", // archived_at
      "1", // version
      lit(row.createdAt),
      lit(row.createdAt),
    ],
  );
}

export interface MessageInsertRow {
  id: string;
  channelId: string;
  threadRootId: string | null;
  authorId: string | null;
  body: string;
  attachmentFileIds: string[];
  createdAt: string;
}

export interface BuildMessageOptions {
  slack: SlackMessage;
  dubChannelId: string;
  slackChannelId: string;
  ledger: SlackImportLedger;
  ctx: MappingContext;
  /** dub file_meta id for each of slack.files, in order (already registered via
   *  buildFileMetaRow by the caller — see slackImportRun.ts). */
  attachmentFileIds?: string[];
  /** Resolved via resolveThreadRootId — requires every message's id (root + replies) to
   *  already be minted in the ledger before this is called (2-pass; see
   *  slackImportRun.ts). null for a top-level message or an orphaned reply. */
  threadRootId?: string | null;
}

/** Map one Slack message to a dub MessageInsertRow. */
export function buildMessageRow(opts: BuildMessageOptions): MessageInsertRow {
  const { slack, dubChannelId, slackChannelId, ledger, ctx } = opts;
  const { id } = mintMessageId(ledger, slackChannelId, slack.ts);
  const createdAt = new Date(slackTsToMs(slack.ts)).toISOString();

  let authorId: string | null = null;
  let body = convertSlackBodyToDubBody(slack.text ?? "", ctx);
  if (slack.user) {
    const mapped = ctx.slackUserIdToDubUserId.get(slack.user);
    if (mapped) {
      authorId = mapped;
    } else {
      const policy = ctx.unmappedUserPolicy ?? DEFAULT_UNMAPPED_POLICY;
      const name = ctx.slackUserIdToDisplayName.get(slack.user) ?? slack.user;
      if (policy === "embed-name") {
        body = `[Slack: ${name}] ${body}`;
      }
      // "skip-message" is handled by the caller BEFORE calling buildMessageRow (see
      // shouldSkipMessage below) — this function always returns a row when called.
    }
  }

  return {
    id,
    channelId: dubChannelId,
    threadRootId: opts.threadRootId ?? null,
    authorId,
    body,
    attachmentFileIds: opts.attachmentFileIds ?? [],
    createdAt,
  };
}

/** Whether buildMessageRow's row should actually be inserted, per unmappedUserPolicy. */
export function shouldSkipMessage(slack: SlackMessage, ctx: MappingContext): boolean {
  if (!slack.user) return false; // no author at all (system/bot) — never skipped on this basis
  if (ctx.slackUserIdToDubUserId.has(slack.user)) return false;
  return (ctx.unmappedUserPolicy ?? DEFAULT_UNMAPPED_POLICY) === "skip-message";
}

/**
 * Resolve one message's thread_root_id. A message is a thread root iff thread_ts is
 * absent or equals its own ts; it is a reply iff thread_ts is present and differs from
 * ts, in which case the root's dub id is looked up from the ledger. Requires the root's
 * id to already be minted (2-pass: callers mint every message's id — root AND replies —
 * before building any row; see runSlackImport's pass 1 in slackImportRun.ts). Returns
 * null (silently) if the root was never minted, e.g. a thread whose root fell outside
 * the fetched history window — the reply still imports, just without a thread anchor.
 */
export function resolveThreadRootId(slack: SlackMessage, slackChannelId: string, ledger: SlackImportLedger): string | null {
  if (!slack.thread_ts || slack.thread_ts === slack.ts) return null;
  return ledger.getMessage(slackChannelId, slack.thread_ts) ?? null;
}

export function buildInsertMessageSql(row: MessageInsertRow): string {
  return insertOrIgnore(
    "chat_messages",
    ["id", "channel_id", "thread_root_id", "author_id", "kind", "body", "attachment_file_ids", "version", "edited_at", "deleted_at", "created_at"],
    [
      lit(row.id),
      lit(row.channelId),
      lit(row.threadRootId),
      lit(row.authorId),
      lit("user"),
      lit(row.body),
      lit(JSON.stringify(row.attachmentFileIds)),
      "1",
      "NULL",
      "NULL",
      lit(row.createdAt),
    ],
  );
}

export interface ReactionInsertRow {
  messageId: string;
  emoji: string;
  userId: string;
  createdAt: string;
}

export interface ReactionBuildResult {
  rows: ReactionInsertRow[];
  skippedUnmappedEmoji: number;
  skippedUnmappedUser: number;
}

/** Slack does not expose per-user reaction timestamps — every reaction on a message is
 *  stamped with the message's own createdAt (best available approximation; ordering
 *  among reactions on the same message is not otherwise observable from the API). */
export function buildReactionRows(slack: SlackMessage, dubMessageId: string, messageCreatedAt: string, ctx: MappingContext): ReactionBuildResult {
  const rows: ReactionInsertRow[] = [];
  let skippedUnmappedEmoji = 0;
  let skippedUnmappedUser = 0;
  for (const r of slack.reactions ?? []) {
    const emoji = resolveEmoji(r.name);
    if (!emoji) {
      skippedUnmappedEmoji += r.users.length; // unmapped shortcode (see SLACK_SHORTCODE_TO_EMOJI)
      continue;
    }
    for (const slackUserId of r.users) {
      const userId = ctx.slackUserIdToDubUserId.get(slackUserId);
      if (!userId) {
        skippedUnmappedUser += 1; // unmapped reactor — dropped (no author_id-less reactions in schema)
        continue;
      }
      rows.push({ messageId: dubMessageId, emoji, userId, createdAt: messageCreatedAt });
    }
  }
  return { rows, skippedUnmappedEmoji, skippedUnmappedUser };
}

export function buildInsertReactionSql(row: ReactionInsertRow): string {
  return insertOrIgnore(
    "chat_reactions",
    ["message_id", "emoji", "user_id", "created_at"],
    [lit(row.messageId), lit(row.emoji), lit(row.userId), lit(row.createdAt)],
  );
}

// ---------------------------------------------------------------------------
// Attachments — file_meta_files (source=r2) + file_meta_links (target_type='message')
// ---------------------------------------------------------------------------

export interface FileMetaInsertRow {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  ownerId: string;
  r2Key: string;
  createdAt: string;
}

export interface FileLinkInsertRow {
  fileId: string;
  targetId: string; // dub message id
  linkedBy: string;
  linkedAt: string;
}

export const R2_ATTACHMENT_BUCKET = "dub-file-attachments";

/** Deterministic R2 key for a Slack file — stable across re-runs (keyed by Slack ids,
 *  not the minted dub file id) so a repeat --apply never re-uploads under a new key. */
export function r2KeyForSlackFile(slackChannelId: string, ts: string, file: SlackFile): string {
  return `slack-import/${slackChannelId}/${ts}/${file.id}-${file.name}`;
}

export function buildFileMetaRow(
  file: SlackFile,
  slackChannelId: string,
  ts: string,
  uploaderId: string,
  ledger: SlackImportLedger,
  createdAt: string,
): FileMetaInsertRow {
  const { id } = mintFileId(ledger, file.id, slackTsToMs(ts));
  return {
    id,
    name: file.name,
    mimeType: file.mimetype ?? "application/octet-stream",
    sizeBytes: file.size ?? 0,
    ownerId: uploaderId,
    r2Key: r2KeyForSlackFile(slackChannelId, ts, file),
    createdAt,
  };
}

export function buildInsertFileMetaSql(row: FileMetaInsertRow): string {
  return insertOrIgnore(
    "file_meta_files",
    ["id", "name", "mime_type", "size_bytes", "owner_id", "visibility", "drive_file_id", "r2_key", "archived_at", "created_by", "created_at", "updated_at"],
    [
      lit(row.id),
      lit(row.name),
      lit(row.mimeType),
      String(row.sizeBytes),
      lit(row.ownerId),
      lit("org"),
      "NULL",
      lit(row.r2Key),
      "NULL",
      lit(row.ownerId),
      lit(row.createdAt),
      lit(row.createdAt),
    ],
  );
}

export function buildFileLinkRow(fileId: string, dubMessageId: string, linkedBy: string, linkedAt: string): FileLinkInsertRow {
  return { fileId, targetId: dubMessageId, linkedBy, linkedAt };
}

export function buildInsertFileLinkSql(row: FileLinkInsertRow): string {
  return insertOrIgnore(
    "file_meta_links",
    ["file_id", "target_type", "target_id", "linked_by", "linked_at", "archived_at"],
    [lit(row.fileId), lit("message"), lit(row.targetId), lit(row.linkedBy), lit(row.linkedAt), "NULL"],
  );
}

// ---------------------------------------------------------------------------
// Batching + size estimate (D1 free-tier write-limit friendliness + preview counts)
// ---------------------------------------------------------------------------

export interface ImportSummary {
  channels: number;
  messages: number;
  /** Messages whose Slack author has no Dub identity mapping. NOT necessarily skipped —
   *  under the default "embed-name" policy these are still imported (see
   *  UnmappedUserPolicy); only "skip-message" actually drops them. */
  messagesSkippedUnmappedAuthor: number;
  reactions: number;
  reactionsSkippedUnmappedEmoji: number;
  reactionsSkippedUnmappedUser: number;
  attachments: number;
  alreadyImportedMessages: number; // ledger hits — not re-emitted
  estimatedStatements: number;
}

export function emptySummary(): ImportSummary {
  return {
    channels: 0,
    messages: 0,
    messagesSkippedUnmappedAuthor: 0,
    reactions: 0,
    reactionsSkippedUnmappedEmoji: 0,
    reactionsSkippedUnmappedUser: 0,
    attachments: 0,
    alreadyImportedMessages: 0,
    estimatedStatements: 0,
  };
}

/** Split a flat list of SQL statements into batches of at most `maxPerBatch` statements
 *  each, so a single `wrangler d1 execute --file` call stays comfortably under D1's
 *  free-tier per-request row/statement limits and any CI/network timeout. */
export function batchStatements(statements: readonly string[], maxPerBatch = 200): string[][] {
  if (statements.length === 0) return [];
  const out: string[][] = [];
  for (let i = 0; i < statements.length; i += maxPerBatch) {
    out.push(statements.slice(i, i + maxPerBatch));
  }
  return out;
}
