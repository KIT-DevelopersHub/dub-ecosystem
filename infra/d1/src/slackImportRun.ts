// Orchestration layer: wires a SlackSource (live Slack API or offline fixtures) + the
// current identity_users export into the ordered SQL statement list the CLI script
// (scripts/slack-import.ts) writes to disk / applies via `wrangler d1 execute`.
//
// Every mapping/SQL decision lives in the pure module (slackImport.ts); this file only
// fetches + sequences. `SlackSource` is the seam that makes it testable end-to-end
// without a live Slack token (test/slackImportRun.test.ts uses infra/d1/fixtures/slack).
import {
  type ImportSummary,
  type MappingContext,
  type SlackBookmark,
  type SlackChannel,
  type SlackMessage,
  type SlackUser,
  authorKeyOf,
  buildBookmarkBody,
  buildChannelRow,
  buildFileMetaRow,
  buildInsertChannelSql,
  buildInsertFileLinkSql,
  buildInsertFileMetaSql,
  buildInsertMemberSql,
  buildInsertMessageSql,
  buildInsertPinSql,
  buildInsertPlaceholderUserSql,
  buildInsertReactionSql,
  buildMessageRow,
  buildReactionRows,
  buildUpsertBookmarkSqls,
  emptySummary,
  isDownloadable,
  placeholderDisplayName,
  placeholderEmailFor,
  placeholderUserIdFor,
  type SlackFile,
} from "./slackImport";

export interface SlackSource {
  listUsers(): Promise<SlackUser[]>;
  listChannels(): Promise<SlackChannel[]>;
  historyForChannel(channelId: string): Promise<SlackMessage[]>;
  repliesForThread(channelId: string, threadTs: string): Promise<SlackMessage[]>;
  membersOfChannel(channelId: string): Promise<string[]>;
  bookmarksForChannel(channelId: string): Promise<SlackBookmark[]>;
}

export interface IdentityUserExportRow {
  id: string;
  email: string;
}

export interface PendingUpload {
  slackChannelId: string;
  slackTs: string;
  file: SlackFile;
  dubFileId: string;
  r2Key: string;
}

export interface SlackImportConfig {
  source: SlackSource;
  /** Channels to import, by Slack id OR name (with or without '#'). Only these are read. */
  targetChannels: readonly string[];
  /** Current dub identity_users export (id + email), used to join Slack users by email. */
  identityUsers: readonly IdentityUserExportRow[];
  /** identity_orgs.id for placeholder users (single-org model). */
  orgId: string;
  /** Operator's identity_users.id — created_by/pinned_by fallback. */
  systemUserId: string;
  includeAttachments?: boolean;
  nowIso?: () => string;
}

export interface SlackImportResult {
  sql: string[];
  summary: ImportSummary;
  pendingUploads: PendingUpload[];
  /** slackChannelId -> dubChannelId, for the CLI's log output. */
  channelIds: Record<string, string>;
}

/** Resolve `--channels` entries (ids or names) against what the token can see. */
export function resolveTargetChannels(all: readonly SlackChannel[], targets: readonly string[]): SlackChannel[] {
  const out: SlackChannel[] = [];
  const missing: string[] = [];
  for (const raw of targets) {
    const t = raw.trim().replace(/^#/, "");
    const hit = all.find((c) => c.id === t) ?? all.find((c) => c.name === t);
    if (hit) {
      if (!out.includes(hit)) out.push(hit);
    } else missing.push(raw);
  }
  if (missing.length > 0) {
    throw new Error(
      `runSlackImport: channel(s) not visible to the bot token: ${missing.join(", ")} (private channels need the bot invited first)`,
    );
  }
  return out;
}

/** History + every thread's full reply set, deduped by ts (roots appear in both). */
async function collectChannelMessages(source: SlackSource, channelId: string): Promise<SlackMessage[]> {
  const history = await source.historyForChannel(channelId);
  const byTs = new Map<string, SlackMessage>(history.map((m) => [m.ts, m] as const));
  for (const m of history) {
    if (m.reply_count && m.reply_count > 0) {
      for (const r of await source.repliesForThread(channelId, m.thread_ts ?? m.ts)) byTs.set(r.ts, r);
    }
  }
  return [...byTs.values()].sort((a, b) => Number(a.ts) - Number(b.ts));
}

interface UserIndex {
  ctx: MappingContext;
  /** Slack keys that resolved to a real (email-matched) Dub account. */
  realKeys: Set<string>;
}

function buildUserIndex(
  slackUsers: readonly SlackUser[],
  identityUsers: readonly IdentityUserExportRow[],
  channels: readonly SlackChannel[],
  systemUserId: string,
): UserIndex {
  const emailToDubId = new Map(identityUsers.map((u) => [u.email.toLowerCase(), u.id] as const));
  const slackUserIdToDubUserId = new Map<string, string>();
  const slackUserIdToDisplayName = new Map<string, string>();
  const realKeys = new Set<string>();
  for (const u of slackUsers) {
    slackUserIdToDisplayName.set(u.id, u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || u.id);
    const dubId = u.profile?.email ? emailToDubId.get(u.profile.email.toLowerCase()) : undefined;
    if (dubId) {
      slackUserIdToDubUserId.set(u.id, dubId);
      realKeys.add(u.id);
    }
  }
  const slackChannelIdToName = new Map(channels.map((c) => [c.id, c.name] as const));
  return { ctx: { slackUserIdToDubUserId, slackUserIdToDisplayName, slackChannelIdToName, systemUserId }, realKeys };
}

export async function runSlackImport(config: SlackImportConfig): Promise<SlackImportResult> {
  const nowIso = (config.nowIso ?? (() => new Date().toISOString()))();
  const [allUsers, allChannels] = await Promise.all([config.source.listUsers(), config.source.listChannels()]);
  const channels = resolveTargetChannels(allChannels, config.targetChannels);
  const { ctx, realKeys } = buildUserIndex(allUsers, config.identityUsers, allChannels, config.systemUserId);
  const usersById = new Map(allUsers.map((u) => [u.id, u] as const));
  const idMap = ctx.slackUserIdToDubUserId as Map<string, string>;
  const nameMap = ctx.slackUserIdToDisplayName as Map<string, string>;

  // Fetch everything first: placeholder users must exist before any row references them.
  const fetched: Array<{ channel: SlackChannel; messages: SlackMessage[]; members: string[]; bookmarks: SlackBookmark[] }> = [];
  for (const channel of channels) {
    const [messages, members, bookmarks] = await Promise.all([
      collectChannelMessages(config.source, channel.id),
      config.source.membersOfChannel(channel.id),
      config.source.bookmarksForChannel(channel.id),
    ]);
    fetched.push({ channel, messages, members, bookmarks });
  }

  const summary: ImportSummary = emptySummary();
  const userSql: string[] = [];
  const sql: string[] = [];
  const pendingUploads: PendingUpload[] = [];
  const channelIds: Record<string, string> = {};

  // Placeholders: every author / reactor without a real Dub account (退職者・ゲスト・bot).
  const ensurePlaceholder = (key: string, fallbackName?: string): void => {
    if (idMap.has(key)) return;
    const u = usersById.get(key);
    const name = nameMap.get(key) || fallbackName || key;
    const isBot = u ? !!u.is_bot : fallbackName !== undefined; // bot_id-only posts
    const id = placeholderUserIdFor(key);
    idMap.set(key, id);
    nameMap.set(key, name);
    userSql.push(buildInsertPlaceholderUserSql({ id, orgId: config.orgId, email: placeholderEmailFor(key), displayName: placeholderDisplayName(name, isBot), createdAt: nowIso }));
    summary.placeholderUsers += 1;
  };
  for (const { messages } of fetched) {
    for (const m of messages) {
      const key = authorKeyOf(m);
      if (key) ensurePlaceholder(key, m.user ? undefined : m.bot_profile?.name || m.username || "bot");
      for (const r of m.reactions ?? []) for (const u of r.users) ensurePlaceholder(u);
    }
  }

  for (const { channel, messages, members, bookmarks } of fetched) {
    const channelRow = buildChannelRow(channel, ctx, nowIso);
    channelIds[channel.id] = channelRow.id;
    sql.push(buildInsertChannelSql(channelRow));
    summary.channels += 1;

    // Real accounts only: placeholders are disabled and never need channel access.
    const memberIds = new Set<string>();
    if (realKeys.has(channel.creator ?? "")) memberIds.add(idMap.get(channel.creator!)!);
    for (const m of members) if (realKeys.has(m)) memberIds.add(idMap.get(m)!);
    for (const userId of memberIds) {
      sql.push(buildInsertMemberSql(channelRow.id, userId, userId === channelRow.createdBy ? "admin" : "member", channelRow.createdAt));
      summary.members += 1;
    }

    const presentTs = new Set(messages.map((m) => m.ts));
    for (const msg of messages) {
      const authorId = idMap.get(authorKeyOf(msg) ?? "") ?? config.systemUserId;
      const createdAt = new Date(Number(msg.ts) * 1000).toISOString();

      const attachmentFileIds: string[] = [];
      if (config.includeAttachments ?? true) {
        for (const file of msg.files ?? []) {
          if (!isDownloadable(file)) {
            summary.attachmentsUnavailable += 1;
            continue;
          }
          const fileRow = buildFileMetaRow(file, channel.id, msg.ts, authorId);
          sql.push(buildInsertFileMetaSql(fileRow));
          attachmentFileIds.push(fileRow.id);
          pendingUploads.push({ slackChannelId: channel.id, slackTs: msg.ts, file, dubFileId: fileRow.id, r2Key: fileRow.r2Key });
          summary.attachments += 1;
        }
      }

      const row = buildMessageRow({ slack: msg, slackChannelId: channel.id, dubChannelId: channelRow.id, ctx, attachmentFileIds });
      // A reply whose root is outside the visible window (free plan: 90 days) would be
      // unreachable inside a missing thread; surface it as a top-level message instead.
      if (row.threadRootId && !presentTs.has(msg.thread_ts!)) row.threadRootId = null;
      sql.push(buildInsertMessageSql(row));
      summary.messages += 1;
      if (row.threadRootId) summary.threadReplies += 1;
      for (const fileId of attachmentFileIds) sql.push(buildInsertFileLinkSql(fileId, row.id, authorId, createdAt));

      for (const reaction of buildReactionRows(msg, row.id, row.createdAt, ctx)) {
        sql.push(buildInsertReactionSql(reaction));
        summary.reactions += 1;
        if (reaction.emoji.startsWith(":")) summary.customEmojiReactions += 1;
      }

      if (msg.pinned_to?.includes(channel.id)) {
        sql.push(buildInsertPinSql(channelRow.id, row.id, channelRow.createdBy, row.createdAt));
        summary.pins += 1;
      }
    }

    const bookmarkBody = buildBookmarkBody(bookmarks);
    if (bookmarkBody) {
      sql.push(...buildUpsertBookmarkSqls(channel, channelRow.id, bookmarkBody, channelRow.createdBy, nowIso));
      summary.bookmarks += bookmarks.filter((b) => b.link).length;
    }
  }

  const all = [...userSql, ...sql];
  summary.estimatedStatements = all.length;
  return { sql: all, summary, pendingUploads, channelIds };
}
