// Orchestration layer: wires a SlackSource (live Slack API or offline fixtures) +
// current identity_users export + ledger into the ordered SQL statement list the CLI
// script (scripts/slack-import.ts) writes to disk / applies via `wrangler d1 execute`.
//
// Kept separate from slackImport.ts (pure mapping) so this file's only job is fetching
// + sequencing; every mapping/SQL decision still lives in the fully-unit-tested pure
// module. `SlackSource` is the seam that makes this testable end-to-end without a live
// Slack token (test/slackImportRun.test.ts drives it against infra/d1/fixtures/slack/*.json).
import {
  type ChannelInsertRow,
  type ImportSummary,
  type MappingContext,
  type SlackChannel,
  type SlackFile,
  type SlackImportLedger,
  type SlackMessage,
  type SlackUser,
  type UnmappedUserPolicy,
  buildChannelRow,
  buildFileLinkRow,
  buildFileMetaRow,
  buildInsertChannelSql,
  buildInsertFileLinkSql,
  buildInsertFileMetaSql,
  buildInsertMessageSql,
  buildInsertReactionSql,
  buildMessageRow,
  buildReactionRows,
  emptySummary,
  mintMessageId,
  resolveThreadRootId,
  shouldSkipMessage,
} from "./slackImport";

export interface SlackSource {
  listUsers(): Promise<SlackUser[]>;
  listChannels(): Promise<SlackChannel[]>;
  historyForChannel(channelId: string): Promise<SlackMessage[]>;
  repliesForThread(channelId: string, threadTs: string): Promise<SlackMessage[]>;
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
  /** Slack channel ids to import — the カンファ関連の指定チャンネル (public + private) the
   *  caller has already decided on. Channels not in this list are ignored even if the
   *  bot can see them (listChannels may return the whole workspace). */
  targetChannelIds: readonly string[];
  /** Current dub identity_users export (id + email), used to join Slack users by email. */
  identityUsers: readonly IdentityUserExportRow[];
  systemUserId: string;
  unmappedUserPolicy?: UnmappedUserPolicy;
  ledger: SlackImportLedger;
  /** Plan file_meta_files/links rows for message attachments. Actual byte download +
   *  R2 upload is the CLI script's job (--apply only); this only decides whether to
   *  emit the rows/pendingUploads at all. Default true. */
  includeAttachments?: boolean;
  /** Import-time timestamp for rows Slack gives no better createdAt for (channel rows,
   *  file_meta rows). Injectable for deterministic tests; defaults to real now(). */
  nowIso?: () => string;
}

export interface SlackImportResult {
  sql: string[];
  summary: ImportSummary;
  pendingUploads: PendingUpload[];
  /** slackChannelId -> dubChannelId, for the CLI's log output. */
  channelIds: Record<string, string>;
}

function buildMappingContext(
  slackUsers: readonly SlackUser[],
  identityUsers: readonly IdentityUserExportRow[],
  channels: readonly SlackChannel[],
  systemUserId: string,
  unmappedUserPolicy: UnmappedUserPolicy | undefined,
): MappingContext {
  const emailToDubId = new Map(identityUsers.map((u) => [u.email.toLowerCase(), u.id] as const));
  const slackUserIdToDubUserId = new Map<string, string>();
  const slackUserIdToDisplayName = new Map<string, string>();
  for (const u of slackUsers) {
    const name = u.profile?.display_name || u.profile?.real_name || u.name || u.id;
    slackUserIdToDisplayName.set(u.id, name);
    const email = u.profile?.email?.toLowerCase();
    if (email) {
      const dubId = emailToDubId.get(email);
      if (dubId) slackUserIdToDubUserId.set(u.id, dubId);
    }
  }
  const slackChannelIdToName = new Map(channels.map((c) => [c.id, c.name] as const));
  return { slackUserIdToDubUserId, slackUserIdToDisplayName, slackChannelIdToName, systemUserId, unmappedUserPolicy };
}

/** Merge conversations.history top-level messages with every thread's full reply set,
 *  deduped by ts (a thread root appears in both history and its own replies page). */
async function collectChannelMessages(source: SlackSource, channelId: string): Promise<SlackMessage[]> {
  const history = await source.historyForChannel(channelId);
  const byTs = new Map<string, SlackMessage>(history.map((m) => [m.ts, m] as const));
  for (const m of history) {
    if (m.reply_count && m.reply_count > 0) {
      const replies = await source.repliesForThread(channelId, m.thread_ts ?? m.ts);
      for (const r of replies) byTs.set(r.ts, r);
    }
  }
  return [...byTs.values()];
}

/** Import one channel's messages into `sql`/`summary`/`pendingUploads`, mutating them
 *  in place (keeps the per-channel loop in runSlackImport small and linear). Two
 *  passes over `messages`: (1) mint-or-reuse every message's id in the ledger — root
 *  AND replies — so thread_root_id can always be resolved by direct ledger lookup;
 *  (2) build + emit rows for messages that are new (not already imported) and not
 *  skipped (shouldSkipMessage). */
function importChannelMessages(
  messages: readonly SlackMessage[],
  channel: SlackChannel,
  channelRow: ChannelInsertRow,
  ctx: MappingContext,
  config: SlackImportConfig,
  nowIso: () => string,
  sql: string[],
  summary: ImportSummary,
  pendingUploads: PendingUpload[],
): void {
  const alreadyImported = new Set<string>();
  for (const msg of messages) {
    const { isNew } = mintMessageId(config.ledger, channel.id, msg.ts);
    if (!isNew) alreadyImported.add(msg.ts);
  }

  for (const msg of messages) {
    if (alreadyImported.has(msg.ts)) {
      summary.alreadyImportedMessages += 1;
      continue; // already imported in a prior run — never re-emit its INSERT
    }
    if (msg.user && !ctx.slackUserIdToDubUserId.has(msg.user)) {
      summary.messagesSkippedUnmappedAuthor += 1; // counted for visibility even under "embed-name"
    }
    if (shouldSkipMessage(msg, ctx)) continue; // "skip-message" policy: no row at all

    const attachmentFileIds: string[] = [];
    if ((config.includeAttachments ?? true) && msg.files && msg.files.length > 0) {
      const uploaderId = (msg.user && ctx.slackUserIdToDubUserId.get(msg.user)) ?? config.systemUserId;
      for (const file of msg.files) {
        const fileRow = buildFileMetaRow(file, channel.id, msg.ts, uploaderId, config.ledger, nowIso());
        sql.push(buildInsertFileMetaSql(fileRow));
        attachmentFileIds.push(fileRow.id);
        pendingUploads.push({ slackChannelId: channel.id, slackTs: msg.ts, file, dubFileId: fileRow.id, r2Key: fileRow.r2Key });
        summary.attachments += 1;
      }
    }

    const row = buildMessageRow({
      slack: msg,
      dubChannelId: channelRow.id,
      slackChannelId: channel.id,
      ledger: config.ledger,
      ctx,
      attachmentFileIds,
      threadRootId: resolveThreadRootId(msg, channel.id, config.ledger),
    });
    sql.push(buildInsertMessageSql(row));
    summary.messages += 1;

    for (const fileId of attachmentFileIds) {
      const uploaderId = (msg.user && ctx.slackUserIdToDubUserId.get(msg.user)) ?? config.systemUserId;
      sql.push(buildInsertFileLinkSql(buildFileLinkRow(fileId, row.id, uploaderId, nowIso())));
    }

    const reactions = buildReactionRows(msg, row.id, row.createdAt, ctx);
    for (const reaction of reactions.rows) sql.push(buildInsertReactionSql(reaction));
    summary.reactions += reactions.rows.length;
    summary.reactionsSkippedUnmappedEmoji += reactions.skippedUnmappedEmoji;
    summary.reactionsSkippedUnmappedUser += reactions.skippedUnmappedUser;
  }
}

export async function runSlackImport(config: SlackImportConfig): Promise<SlackImportResult> {
  const nowIso = config.nowIso ?? (() => new Date().toISOString());

  const [allUsers, allChannels] = await Promise.all([config.source.listUsers(), config.source.listChannels()]);
  const targetSet = new Set(config.targetChannelIds);
  const channels = allChannels.filter((c) => targetSet.has(c.id));
  const missing = [...targetSet].filter((id) => !channels.some((c) => c.id === id));
  if (missing.length > 0) {
    throw new Error(
      `runSlackImport: target channel id(s) not visible to the bot token (not a member, or archived+excluded): ${missing.join(", ")}`,
    );
  }

  const ctx = buildMappingContext(allUsers, config.identityUsers, allChannels, config.systemUserId, config.unmappedUserPolicy);
  const summary: ImportSummary = emptySummary();
  const sql: string[] = [];
  const pendingUploads: PendingUpload[] = [];
  const channelIds: Record<string, string> = {};

  for (const channel of channels) {
    const channelRow: ChannelInsertRow = buildChannelRow(channel, config.ledger, ctx, nowIso());
    channelIds[channel.id] = channelRow.id;
    sql.push(buildInsertChannelSql(channelRow));
    summary.channels += 1;

    const messages = await collectChannelMessages(config.source, channel.id);
    importChannelMessages(messages, channel, channelRow, ctx, config, nowIso, sql, summary, pendingUploads);
  }

  summary.estimatedStatements = sql.length;
  return { sql, summary, pendingUploads, channelIds };
}
