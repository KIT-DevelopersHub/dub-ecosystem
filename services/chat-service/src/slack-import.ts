// In-app Slack channel import (fe6-chat 「チャンネル取り込み」) — a RESUMABLE STEP ENGINE.
//
// Why steps: on the Workers FREE plan one invocation gets ~50 external subrequests and a few
// ms of CPU, so a whole channel cannot be imported in one request. A job row
// (chat_slack_import_jobs) carries the cursor; every POST …/step does a BOUNDED slice of work:
//
//   users    one users.list page (200)          -> Slack user -> Dub account (email join)
//   channel  join (public) + members + bookmarks -> chat_channels / members / bookmark pin
//   history  one conversations.history page (50) -> messages, reactions, pins, file rows
//   threads  up to 8 conversations.replies pages / ~50 replies -> thread replies (+ reactions/files)
//   files    up to 4 downloads -> R2 dub-file-attachments (unavailable -> rows dropped)
//   finalize mark everything read for the channel's members (no unread flood), done
//
// Idempotency + atomicity: every Dub id is derived from the Slack id (@dub/slack-import), all
// rows are INSERT OR IGNORE, and each step's data rows + the job's cursor/counters update go
// in ONE D1 batch (a transaction): a step either lands completely or not at all, and
// re-running any step is a no-op. A lease (lease_token/lease_until) keeps two tabs from
// stepping one job concurrently. A Slack 429 parks the job (next_run_at) instead of sleeping.
//
// Direct writes outside the chat_* namespace — identity_users (disabled placeholder authors)
// and file_meta_files/links (attachments) — are deliberate and mirror the offline CLI
// (infra/d1/scripts/slack-import.ts): going through identity/file-meta APIs would cost one
// subrequest per row and fire notifications/events for history that already happened.
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { errors } from "@dub/errors";
import {
  type MappingContext,
  type SlackChannel,
  type SlackClient,
  type SlackMessage,
  type SlackUser,
  SlackApiError,
  authorKeyOf,
  buildBookmarkBody,
  buildChannelRow,
  buildFileMetaRow,
  buildInsertChannelSql,
  buildInsertFileLinkSql,
  buildInsertFileMetaSql,
  buildInsertMemberSql,
  buildUpsertMessageSql,
  buildInsertPinSql,
  buildInsertPlaceholderUserSql,
  buildInsertReactionSql,
  buildMessageRow,
  buildReactionRows,
  buildUpsertBookmarkSqls,
  buildUpsertThreadReplySql,
  channelIdFor,
  compactStatements,
  isDownloadable,
  lit,
  mentionedSlackUserIds,
  messageIdFor,
  placeholderDisplayName,
  placeholderEmailFor,
  placeholderUserIdFor,
} from "@dub/slack-import";

// ---- bounds per step (free plan: 50 subrequests / invocation) ----
export const HISTORY_PAGE_SIZE = 50;
export const THREADS_PER_STEP = 8;
export const FILES_PER_STEP = 4;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const LEASE_MS = 60_000;
const LEASE_POLL_MS = 1_000;

export type JobStatus = "queued" | "running" | "done" | "failed";
export type JobPhase = "users" | "channel" | "history" | "threads" | "files" | "finalize" | "done";

export interface ImportCounters {
  members: number;
  messages: number;
  threadReplies: number;
  reactions: number;
  pins: number;
  files: number;
  filesSkipped: number;
}

/** Wire shape returned by every slack-import route. */
export interface SlackImportJob {
  id: string;
  slackChannelId: string;
  slackChannelName: string;
  isPrivate: boolean;
  dubChannelId: string;
  status: JobStatus;
  phase: JobPhase;
  counters: ImportCounters;
  /** Pending work still known to the engine (for a progress hint). */
  pending: { threads: number; files: number };
  error: { code: string; message: string } | null;
  /** >0 while parked on a Slack rate limit: the client should wait this long. */
  retryAfterMs: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface SlackChannelOption {
  id: string;
  name: string;
  isPrivate: boolean;
  isArchived: boolean;
  memberCount: number | null;
  /** Latest job for this channel, if it was imported before. */
  job: { id: string; status: JobStatus } | null;
}

/** [displayName, isBot (0|1), real Dub user id | null] — compact for the JSON cursor. */
type UserEntry = [string, 0 | 1, string | null];

interface PendingFile {
  fileId: string;
  messageId: string;
  url: string;
  key: string;
  size: number;
  mime: string;
}

interface JobState {
  channel: SlackChannel;
  usersCursor: string | null;
  users: Record<string, UserEntry>;
  historyCursor: string | null;
  threadQueue: string[];
  threadCursor: string | null;
  fileQueue: PendingFile[];
}

interface JobRow {
  id: string;
  org_id: string;
  slack_channel_id: string;
  slack_channel_name: string;
  is_private: number;
  dub_channel_id: string;
  status: JobStatus;
  phase: JobPhase;
  state: string;
  counters: string;
  error_code: string | null;
  error_message: string | null;
  next_run_at: string | null;
  lease_token: string | null;
  lease_until: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

/** Minimal R2 surface the engine needs (the real binding satisfies it). */
export type AttachmentBucket = Pick<R2Bucket, "put">;

export interface SlackImporterDeps {
  db: D1Database;
  /** null when SLACK_BOT_TOKEN is not configured (routes answer 412). */
  slack: SlackClient | null;
  bucket: AttachmentBucket | null;
  orgId: string;
  now: () => string;
  newJobId: () => string;
  newLeaseToken: () => string;
}

// Error codes stored on a failed job and shown by the UI.
export const JOB_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  not_in_channel: "LMB がこのチャンネルに参加していません。Slack で LMB を招待してから再開してください。",
  channel_not_found: "Slack チャンネルが見つかりません。非公開チャンネルは LMB を招待すると表示されます。",
  is_archived: "アーカイブ済みの公開チャンネルには LMB が参加できません。",
  invalid_auth: "Slack のトークンが無効です。管理者に SLACK_BOT_TOKEN の確認を依頼してください。",
  missing_scope: "Slack アプリの権限(スコープ)が不足しています。",
};

function messageFor(code: string): string {
  return JOB_ERROR_MESSAGES[code] ?? `Slack API エラー: ${code}`;
}

const emptyCounters = (): ImportCounters => ({ members: 0, messages: 0, threadReplies: 0, reactions: 0, pins: 0, files: 0, filesSkipped: 0 });

function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function toWire(row: JobRow, nowIso: string): SlackImportJob {
  const state = JSON.parse(row.state) as JobState;
  const nowMs = Date.parse(nowIso);
  let waitMs = row.next_run_at ? Math.max(0, Date.parse(row.next_run_at) - nowMs) : 0;
  // Another tab is mid-step: poll again shortly instead of hammering the lease.
  if (row.lease_until && Date.parse(row.lease_until) > nowMs) waitMs = Math.max(waitMs, LEASE_POLL_MS);
  return {
    id: row.id,
    slackChannelId: row.slack_channel_id,
    slackChannelName: row.slack_channel_name,
    isPrivate: row.is_private === 1,
    dubChannelId: row.dub_channel_id,
    status: row.status,
    phase: row.phase,
    counters: { ...emptyCounters(), ...(JSON.parse(row.counters) as Partial<ImportCounters>) },
    pending: { threads: state.threadQueue.length, files: state.fileQueue.length },
    error: row.error_code ? { code: row.error_code, message: row.error_message ?? messageFor(row.error_code) } : null,
    retryAfterMs: row.status === "running" ? waitMs : 0,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

/** Only the fields the engine reads — keeps the persisted cursor small. */
function slimChannel(c: SlackChannel): SlackChannel {
  return {
    id: c.id,
    name: c.name,
    ...(c.created !== undefined ? { created: c.created } : {}),
    ...(c.is_private !== undefined ? { is_private: c.is_private } : {}),
    ...(c.is_member !== undefined ? { is_member: c.is_member } : {}),
    ...(c.is_archived !== undefined ? { is_archived: c.is_archived } : {}),
    ...(c.topic?.value ? { topic: { value: c.topic.value } } : {}),
    ...(c.purpose?.value ? { purpose: { value: c.purpose.value } } : {}),
    ...(c.creator ? { creator: c.creator } : {}),
  };
}

function dropFileSqls(f: PendingFile): string[] {
  return [
    `UPDATE chat_messages SET attachment_file_ids = (SELECT json_group_array(value) FROM json_each(chat_messages.attachment_file_ids) WHERE value <> ${lit(f.fileId)}) WHERE id = ${lit(f.messageId)};`,
    `DELETE FROM file_meta_links WHERE file_id = ${lit(f.fileId)};`,
    `DELETE FROM file_meta_files WHERE id = ${lit(f.fileId)};`,
  ];
}

function freshState(channel: SlackChannel): JobState {
  return { channel: slimChannel(channel), usersCursor: null, users: {}, historyCursor: null, threadQueue: [], threadCursor: null, fileQueue: [] };
}

/**
 * Per-step accumulator: resolves Slack authors/reactors/mentions to Dub ids (real account or
 * a disabled placeholder) and collects the SQL for one atomic batch.
 */
class StepWriter {
  readonly sql: string[] = [];
  private readonly placeholders: string[] = [];
  private readonly seenPlaceholders = new Set<string>();
  readonly ctx: MappingContext;
  private readonly idMap = new Map<string, string>();

  constructor(
    private readonly state: JobState,
    private readonly orgId: string,
    private readonly systemUserId: string,
    private readonly nowIso: string,
    readonly counters: ImportCounters,
    /** false when no R2 bucket is bound: attachments are counted as skipped, no rows. */
    private readonly canStoreFiles: boolean,
  ) {
    const names = new Map<string, string>();
    for (const [id, [name]] of Object.entries(state.users)) names.set(id, name);
    this.ctx = {
      slackUserIdToDubUserId: this.idMap,
      slackUserIdToDisplayName: names,
      slackChannelIdToName: new Map([[state.channel.id, state.channel.name]]),
      systemUserId,
    };
  }

  /** Dub id for a Slack user/bot key, minting a disabled placeholder when unmapped. */
  resolve(key: string, botName?: string): string {
    const known = this.idMap.get(key);
    if (known) return known;
    const entry = this.state.users[key];
    if (entry?.[2]) {
      this.idMap.set(key, entry[2]);
      return entry[2];
    }
    const id = placeholderUserIdFor(key);
    this.idMap.set(key, id);
    if (!this.seenPlaceholders.has(key)) {
      this.seenPlaceholders.add(key);
      const name = entry?.[0] ?? botName ?? key;
      const isBot = entry ? entry[1] === 1 : botName !== undefined;
      this.placeholders.push(
        buildInsertPlaceholderUserSql({ id, orgId: this.orgId, email: placeholderEmailFor(key), displayName: placeholderDisplayName(name, isBot), createdAt: this.nowIso }),
      );
    }
    return id;
  }

  /** Map every Slack id a message touches BEFORE building its row, so `<@U…>` mentions
   *  render as Dub mentions and every author/reactor exists. */
  private prime(m: SlackMessage): void {
    const key = authorKeyOf(m);
    if (key) this.resolve(key, m.user ? undefined : m.bot_profile?.name || m.username || "bot");
    for (const r of m.reactions ?? []) for (const u of r.users) this.resolve(u);
    for (const u of mentionedSlackUserIds(m.text)) this.resolve(u);
  }

  addMessage(m: SlackMessage, dubChannelId: string, opts: { asThreadReply: boolean }): void {
    this.prime(m);
    const channel = this.state.channel;
    const authorId = this.idMap.get(authorKeyOf(m) ?? "") ?? this.systemUserId;
    const attachmentFileIds: string[] = [];
    const messageId = messageIdFor(channel.id, m.ts);
    for (const file of m.files ?? []) {
      // Skipped up front = no file rows, so the message never shows a dead attachment.
      if (!isDownloadable(file) || !this.canStoreFiles || (file.size ?? 0) > MAX_FILE_BYTES) {
        this.counters.filesSkipped += 1;
        continue;
      }
      const fileRow = buildFileMetaRow(file, channel.id, m.ts, authorId);
      this.sql.push(buildInsertFileMetaSql(fileRow));
      attachmentFileIds.push(fileRow.id);
      this.state.fileQueue.push({ fileId: fileRow.id, messageId, url: file.url_private!, key: fileRow.r2Key, size: fileRow.sizeBytes, mime: fileRow.mimeType });
    }
    const row = buildMessageRow({ slack: m, slackChannelId: channel.id, dubChannelId, ctx: this.ctx, attachmentFileIds });
    if (opts.asThreadReply) {
      this.sql.push(buildUpsertThreadReplySql(row));
      if (row.threadRootId) this.counters.threadReplies += 1;
    } else {
      // History pass: a broadcast reply is written top-level for now; the threads pass
      // attaches it to its root (or it stays top-level if the root is outside 90 days).
      row.threadRootId = null;
      this.sql.push(buildUpsertMessageSql(row));
    }
    this.counters.messages += 1;
    for (const fileId of attachmentFileIds) this.sql.push(buildInsertFileLinkSql(fileId, row.id, authorId, row.createdAt));
    for (const reaction of buildReactionRows(m, row.id, row.createdAt, this.ctx)) {
      this.sql.push(buildInsertReactionSql(reaction));
      this.counters.reactions += 1;
    }
    if (m.pinned_to?.includes(channel.id)) {
      this.sql.push(buildInsertPinSql(dubChannelId, row.id, this.systemUserId, row.createdAt));
      this.counters.pins += 1;
    }
  }

  statements(): string[] {
    return compactStatements([...this.placeholders, ...this.sql]);
  }
}

export class SlackImporter {
  constructor(private readonly deps: SlackImporterDeps) {}

  private requireSlack(): SlackClient {
    if (!this.deps.slack) throw errors.preconditionFailed("slack_import_not_configured: SLACK_BOT_TOKEN is not set on chat-service");
    return this.deps.slack;
  }

  private async loadRow(id: string): Promise<JobRow> {
    const row = await this.deps.db
      .prepare("SELECT * FROM chat_slack_import_jobs WHERE id = ? AND org_id = ?")
      .bind(id, this.deps.orgId)
      .first<JobRow>();
    if (!row) throw errors.notFound("slack_import_job", id);
    return row;
  }

  async getJob(id: string): Promise<SlackImportJob> {
    return toWire(await this.loadRow(id), this.deps.now());
  }

  async listJobs(limit = 20): Promise<{ items: SlackImportJob[] }> {
    const res = await this.deps.db
      .prepare("SELECT * FROM chat_slack_import_jobs WHERE org_id = ? ORDER BY updated_at DESC LIMIT ?")
      .bind(this.deps.orgId, Math.min(Math.max(1, limit), 50))
      .all<JobRow>();
    const now = this.deps.now();
    return { items: (res.results ?? []).map((r) => toWire(r, now)) };
  }

  /** Channels the bot can see, for the picker. Private ones appear only once LMB is invited. */
  async listSlackChannels(): Promise<{ items: SlackChannelOption[] }> {
    const slack = this.requireSlack();
    const channels = await this.callSlack(() => slack.listChannels());
    const jobs = await this.deps.db
      .prepare("SELECT id, slack_channel_id, status FROM chat_slack_import_jobs WHERE org_id = ?")
      .bind(this.deps.orgId)
      .all<{ id: string; slack_channel_id: string; status: JobStatus }>();
    const bySlackId = new Map((jobs.results ?? []).map((j) => [j.slack_channel_id, { id: j.id, status: j.status }] as const));
    const items = channels
      .map((c) => ({
        id: c.id,
        name: c.name,
        isPrivate: !!c.is_private,
        isArchived: !!c.is_archived,
        memberCount: c.num_members ?? null,
        job: bySlackId.get(c.id) ?? null,
      }))
      .sort((a, b) => Number(a.isArchived) - Number(b.isArchived) || a.name.localeCompare(b.name));
    return { items };
  }

  /**
   * Create (or resume) the job for one Slack channel, by name ("#general" / "general") or id.
   * One row per Slack channel: queued/running -> returned as is; failed -> resumed from its
   * cursor; done -> restarted from scratch (picks up messages posted since — ids dedupe).
   */
  async createJob(channelRef: string, createdBy: string): Promise<{ job: SlackImportJob; created: boolean }> {
    const ref = channelRef.trim().replace(/^#/, "");
    if (!ref) throw errors.validationFailed([{ field: "channel", reason: "required" }]);
    const slack = this.requireSlack();
    const all = await this.callSlack(() => slack.listChannels());
    const channel = all.find((c) => c.id === ref) ?? all.find((c) => c.name === ref);
    if (!channel) throw errors.notFound("slack_channel", ref);
    const now = this.deps.now();
    const existing = await this.deps.db
      .prepare("SELECT * FROM chat_slack_import_jobs WHERE org_id = ? AND slack_channel_id = ?")
      .bind(this.deps.orgId, channel.id)
      .first<JobRow>();
    if (existing) {
      if (existing.status === "failed") {
        await this.deps.db
          .prepare("UPDATE chat_slack_import_jobs SET status = 'queued', error_code = NULL, error_message = NULL, next_run_at = NULL, updated_at = ? WHERE id = ?")
          .bind(now, existing.id)
          .run();
      } else if (existing.status === "done") {
        await this.deps.db
          .prepare(
            "UPDATE chat_slack_import_jobs SET status = 'queued', phase = 'users', state = ?, counters = ?, error_code = NULL, error_message = NULL, next_run_at = NULL, lease_token = NULL, lease_until = NULL, finished_at = NULL, created_by = ?, updated_at = ? WHERE id = ?",
          )
          .bind(JSON.stringify(freshState(channel)), JSON.stringify(emptyCounters()), createdBy, now, existing.id)
          .run();
      }
      return { job: await this.getJob(existing.id), created: false };
    }
    // ON CONFLICT: two admins starting the same channel at once share one job (no 500).
    const inserted = await this.deps.db
      .prepare(
        `INSERT INTO chat_slack_import_jobs (id, org_id, slack_channel_id, slack_channel_name, is_private, dub_channel_id, status, phase, state, counters, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', 'users', ?, ?, ?, ?, ?)
         ON CONFLICT(org_id, slack_channel_id) DO NOTHING`,
      )
      .bind(this.deps.newJobId(), this.deps.orgId, channel.id, channel.name, channel.is_private ? 1 : 0, channelIdFor(channel), JSON.stringify(freshState(channel)), JSON.stringify(emptyCounters()), createdBy, now, now)
      .run();
    const row = await this.deps.db
      .prepare("SELECT * FROM chat_slack_import_jobs WHERE org_id = ? AND slack_channel_id = ?")
      .bind(this.deps.orgId, channel.id)
      .first<JobRow>();
    return { job: toWire(row!, now), created: (inserted.meta?.changes ?? 0) === 1 };
  }

  /** Advance one bounded step. Safe to call concurrently / repeatedly (lease + idempotency). */
  async step(id: string): Promise<SlackImportJob> {
    const slack = this.requireSlack();
    const now = this.deps.now();
    const token = this.deps.newLeaseToken();
    const leased = await this.deps.db
      .prepare(
        `UPDATE chat_slack_import_jobs SET status = 'running', lease_token = ?, lease_until = ?, updated_at = ?
         WHERE id = ? AND org_id = ? AND status IN ('queued','running')
           AND (lease_until IS NULL OR lease_until < ?) AND (next_run_at IS NULL OR next_run_at <= ?)`,
      )
      .bind(token, addMs(now, LEASE_MS), now, id, this.deps.orgId, now, now)
      .run();
    const row = await this.loadRow(id);
    // Not ours to run (done / failed / parked on a rate limit / another tab holds the lease).
    if ((leased.meta?.changes ?? 0) !== 1 || row.lease_token !== token) return toWire(row, now);

    const state = JSON.parse(row.state) as JobState;
    const counters: ImportCounters = { ...emptyCounters(), ...(JSON.parse(row.counters) as Partial<ImportCounters>) };
    try {
      const { phase, statements } = await this.runPhase(slack, row, state, counters, now);
      const done = phase === "done";
      const update = this.deps.db
        .prepare(
          `UPDATE chat_slack_import_jobs SET phase = ?, state = ?, counters = ?, status = ?, next_run_at = NULL,
             lease_token = NULL, lease_until = NULL, updated_at = ?, finished_at = ?
           WHERE id = ? AND lease_token = ?`,
        )
        .bind(phase, JSON.stringify(state), JSON.stringify(counters), done ? "done" : "running", now, done ? now : null, id, token);
      await this.deps.db.batch([...statements.map((s) => this.deps.db.prepare(s)), update]);
    } catch (e) {
      await this.recordFailure(id, token, e, now);
    }
    return this.getJob(id);
  }

  private async recordFailure(id: string, token: string, e: unknown, now: string): Promise<void> {
    if (e instanceof SlackApiError && e.slackError === "rate_limited") {
      // Transient: park the job; the client waits retryAfterMs and steps again.
      await this.deps.db
        .prepare("UPDATE chat_slack_import_jobs SET next_run_at = ?, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND lease_token = ?")
        .bind(addMs(now, (e.retryAfterSec ?? 30) * 1000), now, id, token)
        .run();
      return;
    }
    const code = e instanceof SlackApiError ? e.slackError : "internal";
    const message = e instanceof SlackApiError ? messageFor(code) : `取り込み中にエラーが発生しました: ${e instanceof Error ? e.message : String(e)}`;
    await this.deps.db
      .prepare(
        "UPDATE chat_slack_import_jobs SET status = 'failed', error_code = ?, error_message = ?, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND lease_token = ?",
      )
      .bind(code, message, now, id, token)
      .run();
  }

  /** Slack errors outside a job (picker / create) -> a DubError the client can map. */
  private async callSlack<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof SlackApiError) {
        if (e.slackError === "rate_limited") throw errors.rateLimited(e.retryAfterSec ?? 30);
        throw errors.conflict(messageFor(e.slackError), { reason: e.slackError });
      }
      throw e;
    }
  }

  private async runPhase(
    slack: SlackClient,
    row: JobRow,
    state: JobState,
    counters: ImportCounters,
    now: string,
  ): Promise<{ phase: JobPhase; statements: string[] }> {
    const w = new StepWriter(state, row.org_id, row.created_by, now, counters, this.deps.bucket !== null);
    const channel = state.channel;
    const dubChannelId = row.dub_channel_id;

    switch (row.phase) {
      case "users": {
        const page = await slack.usersPage(state.usersCursor);
        await this.indexUsers(page.items, state);
        state.usersCursor = page.nextCursor;
        return { phase: page.nextCursor ? "users" : "channel", statements: [] };
      }

      case "channel": {
        if (!channel.is_private && !channel.is_member) await slack.joinChannel(channel.id);
        const members = await slack.membersOfChannel(channel.id);
        const bookmarks = await slack.bookmarksForChannel(channel.id);
        if (channel.creator) w.resolve(channel.creator);
        const channelRow = buildChannelRow(channel, w.ctx, now);
        w.sql.push(buildInsertChannelSql(channelRow));
        // Real accounts only (placeholders are disabled), plus the importing admin so the
        // finished channel — private ones included — opens for them right away.
        const memberIds = new Set<string>([row.created_by]);
        for (const m of members) {
          const real = state.users[m]?.[2];
          if (real) memberIds.add(real);
        }
        if (channel.creator && state.users[channel.creator]?.[2]) memberIds.add(state.users[channel.creator]![2]!);
        for (const userId of memberIds) {
          w.sql.push(buildInsertMemberSql(dubChannelId, userId, userId === channelRow.createdBy ? "admin" : "member", now));
        }
        counters.members = memberIds.size;
        const body = buildBookmarkBody(bookmarks);
        if (body) w.sql.push(...buildUpsertBookmarkSqls(channel, dubChannelId, body, channelRow.createdBy, now));
        return { phase: "history", statements: w.statements() };
      }

      case "history": {
        const page = await slack.historyPage(channel.id, state.historyCursor, HISTORY_PAGE_SIZE);
        for (const m of page.items) {
          w.addMessage(m, dubChannelId, { asThreadReply: false });
          if (m.reply_count && m.reply_count > 0 && (!m.thread_ts || m.thread_ts === m.ts)) state.threadQueue.push(m.ts);
        }
        state.historyCursor = page.nextCursor;
        return { phase: page.nextCursor ? "history" : "threads", statements: w.statements() };
      }

      case "threads": {
        // Bounded by calls AND messages (CPU: every row hashes ids), like one history page.
        let seen = 0;
        for (let calls = 0; calls < THREADS_PER_STEP && seen < HISTORY_PAGE_SIZE && state.threadQueue.length > 0; calls++) {
          const rootTs = state.threadQueue[0]!;
          let page: { items: SlackMessage[]; nextCursor: string | null };
          try {
            page = await slack.repliesPage(channel.id, rootTs, state.threadCursor, HISTORY_PAGE_SIZE);
          } catch (e) {
            // Root deleted / hidden since the history pass: nothing to attach, skip it.
            if (!(e instanceof SlackApiError && e.slackError === "thread_not_found")) throw e;
            page = { items: [], nextCursor: null };
          }
          for (const m of page.items) {
            if (m.ts === rootTs) continue;
            w.addMessage(m, dubChannelId, { asThreadReply: true });
            seen += 1;
          }
          state.threadCursor = page.nextCursor;
          if (!page.nextCursor) state.threadQueue.shift();
        }
        return { phase: state.threadQueue.length > 0 ? "threads" : "files", statements: w.statements() };
      }

      case "files": {
        const statements: string[] = [];
        for (let i = 0; i < FILES_PER_STEP && state.fileQueue.length > 0; i++) {
          const f = state.fileQueue.shift()!;
          const bytes = this.deps.bucket ? await slack.downloadFile(f.url) : null;
          if (bytes && bytes.byteLength <= MAX_FILE_BYTES && this.deps.bucket) {
            await this.deps.bucket.put(f.key, bytes, { httpMetadata: { contentType: f.mime } });
            counters.files += 1;
          } else {
            // Unavailable body: drop the rows the history pass wrote, so no dead attachment.
            counters.filesSkipped += 1;
            statements.push(...dropFileSqls(f));
          }
        }
        return { phase: state.fileQueue.length > 0 ? "files" : "finalize", statements };
      }

      case "finalize": {
        // Members start "caught up": history is not news, so no unread flood. Only rows
        // that do not exist yet — a member who already read part of it keeps their state.
        return {
          phase: "done",
          statements: [
            `INSERT OR IGNORE INTO chat_read_states (channel_id, user_id, last_read_message_id, updated_at)
SELECT channel_id, user_id, (SELECT MAX(id) FROM chat_messages WHERE channel_id = ${lit(dubChannelId)}), ${lit(now)}
FROM chat_channel_members WHERE channel_id = ${lit(dubChannelId)};`,
          ],
        };
      }

      default:
        return { phase: "done", statements: [] };
    }
  }

  /** Join one users.list page to Dub accounts by email (one query via json_each). */
  private async indexUsers(users: readonly SlackUser[], state: JobState): Promise<void> {
    const emails = [...new Set(users.map((u) => u.profile?.email?.toLowerCase()).filter((e): e is string => !!e))];
    const byEmail = new Map<string, string>();
    if (emails.length > 0) {
      const res = await this.deps.db
        .prepare("SELECT id, lower(email) AS email FROM identity_users WHERE org_id = ? AND lower(email) IN (SELECT value FROM json_each(?))")
        .bind(this.deps.orgId, JSON.stringify(emails))
        .all<{ id: string; email: string }>();
      for (const r of res.results ?? []) byEmail.set(r.email, r.id);
    }
    for (const u of users) {
      const name = u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || u.id;
      const real = u.profile?.email ? (byEmail.get(u.profile.email.toLowerCase()) ?? null) : null;
      state.users[u.id] = [name, u.is_bot ? 1 : 0, real];
    }
  }
}
