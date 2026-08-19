// D1-backed ChatRepo. Owns namespace `chat_*` only (enforced by @dub/db strict
// client). All timestamps come from the service (nowIso), never DDL DEFAULT (D2).
// No cross-namespace joins (chat is the DB-split first candidate).
import type { DbClient } from "@dub/db";
import type { common } from "@dub/types";
import type { ChatRepo, ChannelRow, MemberRow, MessageRow, SearchRow, ChannelType, ChannelVisibility, ChannelRole, MessageKind, MessageDeletionMode } from "./types";

interface ChannelDbRow {
  id: string;
  type: string;
  visibility: string;
  name: string;
  topic: string | null;
  event_id: string | null;
  dm_key: string | null;
  created_by: string;
  archived_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}
interface MemberDbRow {
  channel_id: string;
  user_id: string;
  role: string;
  joined_at: string;
}
interface MessageDbRow {
  id: string;
  channel_id: string;
  thread_root_id: string | null;
  author_id: string | null;
  kind: string;
  body: string;
  attachment_file_ids: string;
  version: number;
  edited_at: string | null;
  deleted_at: string | null;
  created_at: string;
}

function toChannelRow(r: ChannelDbRow): ChannelRow {
  return {
    id: r.id,
    type: r.type as ChannelType,
    visibility: r.visibility as ChannelVisibility,
    name: r.name,
    topic: r.topic,
    eventId: r.event_id,
    dmKey: r.dm_key,
    createdBy: r.created_by,
    archivedAt: r.archived_at,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function toMemberRow(r: MemberDbRow): MemberRow {
  return { channelId: r.channel_id, userId: r.user_id, role: r.role as ChannelRole, joinedAt: r.joined_at };
}
function toMessageRow(r: MessageDbRow): MessageRow {
  let attachments: string[] = [];
  try {
    const parsed = JSON.parse(r.attachment_file_ids) as unknown;
    if (Array.isArray(parsed)) attachments = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    attachments = [];
  }
  return {
    id: r.id,
    channelId: r.channel_id,
    threadRootId: r.thread_root_id,
    authorId: r.author_id,
    kind: r.kind as MessageKind,
    body: r.body,
    attachmentFileIds: attachments,
    version: r.version,
    editedAt: r.edited_at,
    deletedAt: r.deleted_at,
    createdAt: r.created_at,
  };
}

export function createD1ChatRepo(db: DbClient): ChatRepo {
  return {
    // ---- channels ----
    async createChannel(row: ChannelRow): Promise<void> {
      await db.run(
        `INSERT INTO chat_channels
          (id, type, visibility, name, topic, event_id, dm_key, created_by, archived_at, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id, row.type, row.visibility, row.name, row.topic, row.eventId, row.dmKey,
        row.createdBy, row.archivedAt, row.version, row.createdAt, row.updatedAt,
      );
    },
    async getChannel(id: common.ChannelId): Promise<ChannelRow | null> {
      const r = await db.first<ChannelDbRow>(`SELECT * FROM chat_channels WHERE id = ?`, id);
      return r ? toChannelRow(r) : null;
    },
    async getChannelByDmKey(dmKey: string): Promise<ChannelRow | null> {
      const r = await db.first<ChannelDbRow>(`SELECT * FROM chat_channels WHERE dm_key = ?`, dmKey);
      return r ? toChannelRow(r) : null;
    },
    async listChannelsForUser(q): Promise<ChannelRow[]> {
      const where: string[] = [
        `(visibility = 'public' OR EXISTS (SELECT 1 FROM chat_channel_members m WHERE m.channel_id = chat_channels.id AND m.user_id = ?))`,
      ];
      const binds: unknown[] = [q.userId];
      if (!q.includeArchived) where.push("archived_at IS NULL");
      if (q.eventId) {
        where.push("event_id = ?");
        binds.push(q.eventId);
      }
      if (q.afterId) {
        where.push("id > ?");
        binds.push(q.afterId);
      }
      binds.push(q.limit);
      const rows = await db.all<ChannelDbRow>(
        `SELECT * FROM chat_channels WHERE ${where.join(" AND ")} ORDER BY id ASC LIMIT ?`,
        ...binds,
      );
      return rows.map(toChannelRow);
    },
    async updateChannel(next: ChannelRow, expectedVersion: number): Promise<boolean> {
      const res = await db.run(
        `UPDATE chat_channels SET name = ?, topic = ?, archived_at = ?, version = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
        next.name, next.topic, next.archivedAt, next.version, next.updatedAt, next.id, expectedVersion,
      );
      return res.meta.changes > 0;
    },

    // ---- members ----
    async addMember(row: MemberRow): Promise<void> {
      // UPDATE-then-INSERT rather than "ON CONFLICT DO UPDATE SET": the @dub/db
      // namespace guard parses the token after "UPDATE", and in "DO UPDATE SET"
      // that token is "SET" -> a false DB_NAMESPACE_VIOLATION under strict mode.
      // This preserves the upsert semantics (role updated, joined_at kept on conflict).
      const upd = await db.run(
        `UPDATE chat_channel_members SET role = ? WHERE channel_id = ? AND user_id = ?`,
        row.role, row.channelId, row.userId,
      );
      if (upd.meta.changes === 0) {
        await db.run(
          `INSERT OR IGNORE INTO chat_channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)`,
          row.channelId, row.userId, row.role, row.joinedAt,
        );
      }
    },
    async removeMember(channelId: common.ChannelId, userId: common.UserId): Promise<boolean> {
      const res = await db.run(`DELETE FROM chat_channel_members WHERE channel_id = ? AND user_id = ?`, channelId, userId);
      return res.meta.changes > 0;
    },
    async getMember(channelId: common.ChannelId, userId: common.UserId): Promise<MemberRow | null> {
      const r = await db.first<MemberDbRow>(`SELECT * FROM chat_channel_members WHERE channel_id = ? AND user_id = ?`, channelId, userId);
      return r ? toMemberRow(r) : null;
    },
    async listMembers(channelId: common.ChannelId): Promise<MemberRow[]> {
      const rows = await db.all<MemberDbRow>(`SELECT * FROM chat_channel_members WHERE channel_id = ? ORDER BY user_id ASC`, channelId);
      return rows.map(toMemberRow);
    },
    async membershipsForUser(userId: common.UserId): Promise<MemberRow[]> {
      const rows = await db.all<MemberDbRow>(`SELECT * FROM chat_channel_members WHERE user_id = ? ORDER BY channel_id ASC`, userId);
      return rows.map(toMemberRow);
    },

    // ---- messages ----
    async createMessage(row: MessageRow): Promise<void> {
      await db.run(
        `INSERT INTO chat_messages
          (id, channel_id, thread_root_id, author_id, kind, body, attachment_file_ids, version, edited_at, deleted_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id, row.channelId, row.threadRootId, row.authorId, row.kind, row.body,
        JSON.stringify(row.attachmentFileIds), row.version, row.editedAt, row.deletedAt, row.createdAt,
      );
    },
    async getMessage(id: common.MessageId): Promise<MessageRow | null> {
      const r = await db.first<MessageDbRow>(`SELECT * FROM chat_messages WHERE id = ?`, id);
      return r ? toMessageRow(r) : null;
    },
    async listMessages(q): Promise<MessageRow[]> {
      const where: string[] = ["channel_id = ?"];
      const binds: unknown[] = [q.channelId];
      if (q.threadRootId !== undefined) {
        where.push("thread_root_id = ?");
        binds.push(q.threadRootId);
      } else {
        // Main timeline = top-level messages only; replies live in the thread pane
        // (Slack-parity). Fetched via threadRootId above.
        where.push("thread_root_id IS NULL");
      }
      let order: string;
      if (q.afterMessageId !== undefined) {
        where.push("id > ?");
        binds.push(q.afterMessageId);
        order = "ORDER BY id ASC";
      } else {
        if (q.beforeId !== undefined) {
          where.push("id < ?");
          binds.push(q.beforeId);
        }
        order = "ORDER BY id DESC";
      }
      binds.push(q.limit);
      const rows = await db.all<MessageDbRow>(
        `SELECT * FROM chat_messages WHERE ${where.join(" AND ")} ${order} LIMIT ?`,
        ...binds,
      );
      return rows.map(toMessageRow);
    },
    async replyCounts(rootIds): Promise<Map<string, number>> {
      const out = new Map<string, number>();
      if (rootIds.length === 0) return out;
      const placeholders = rootIds.map(() => "?").join(", ");
      const rows = await db.all<{ root: string; n: number }>(
        `SELECT thread_root_id AS root, COUNT(*) AS n FROM chat_messages
          WHERE thread_root_id IN (${placeholders}) AND deleted_at IS NULL
          GROUP BY thread_root_id`,
        ...rootIds,
      );
      for (const r of rows) out.set(r.root, Number(r.n));
      return out;
    },
    async updateMessage(next: MessageRow, expectedVersion: number): Promise<boolean> {
      const res = await db.run(
        `UPDATE chat_messages SET body = ?, attachment_file_ids = ?, version = ?, edited_at = ?, deleted_at = ?
         WHERE id = ? AND version = ?`,
        next.body, JSON.stringify(next.attachmentFileIds), next.version, next.editedAt, next.deletedAt, next.id, expectedVersion,
      );
      return res.meta.changes > 0;
    },

    // ---- reactions ----
    async hasReaction(messageId, emoji, userId): Promise<boolean> {
      const r = await db.first<{ one: number }>(
        `SELECT 1 AS one FROM chat_reactions WHERE message_id = ? AND emoji = ? AND user_id = ?`,
        messageId, emoji, userId,
      );
      return r !== null;
    },
    async addReaction(messageId, emoji, userId, at): Promise<void> {
      await db.run(
        `INSERT INTO chat_reactions (message_id, emoji, user_id, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(message_id, emoji, user_id) DO NOTHING`,
        messageId, emoji, userId, at,
      );
    },
    async removeReaction(messageId, emoji, userId): Promise<boolean> {
      const res = await db.run(
        `DELETE FROM chat_reactions WHERE message_id = ? AND emoji = ? AND user_id = ?`,
        messageId, emoji, userId,
      );
      return res.meta.changes > 0;
    },
    async reactionsFor(messageIds): Promise<Map<string, Record<string, common.UserId[]>>> {
      const out = new Map<string, Record<string, common.UserId[]>>();
      if (messageIds.length === 0) return out;
      const placeholders = messageIds.map(() => "?").join(", ");
      const rows = await db.all<{ message_id: string; emoji: string; user_id: string }>(
        `SELECT message_id, emoji, user_id FROM chat_reactions WHERE message_id IN (${placeholders}) ORDER BY created_at ASC, user_id ASC`,
        ...messageIds,
      );
      for (const r of rows) {
        const map = out.get(r.message_id) ?? {};
        (map[r.emoji] ??= []).push(r.user_id);
        out.set(r.message_id, map);
      }
      return out;
    },

    // ---- read states ----
    async setReadState(channelId, userId, lastReadMessageId, at): Promise<void> {
      // UPDATE-then-INSERT (see addMember): "DO UPDATE SET" trips the @dub/db
      // strict namespace guard, so the upsert is expressed as two guard-safe stmts.
      const upd = await db.run(
        `UPDATE chat_read_states SET last_read_message_id = ?, updated_at = ? WHERE channel_id = ? AND user_id = ?`,
        lastReadMessageId, at, channelId, userId,
      );
      if (upd.meta.changes === 0) {
        await db.run(
          `INSERT OR IGNORE INTO chat_read_states (channel_id, user_id, last_read_message_id, updated_at) VALUES (?, ?, ?, ?)`,
          channelId, userId, lastReadMessageId, at,
        );
      }
    },
    async getReadState(channelId, userId): Promise<{ lastReadMessageId: common.MessageId | null } | null> {
      const r = await db.first<{ last_read_message_id: string | null }>(
        `SELECT last_read_message_id FROM chat_read_states WHERE channel_id = ? AND user_id = ?`,
        channelId, userId,
      );
      return r ? { lastReadMessageId: r.last_read_message_id } : null;
    },
    async countUnread(channelId, userId, lastReadMessageId): Promise<number> {
      const sql = lastReadMessageId === null
        ? `SELECT COUNT(*) AS n FROM chat_messages WHERE channel_id = ? AND deleted_at IS NULL AND (author_id IS NULL OR author_id != ?)`
        : `SELECT COUNT(*) AS n FROM chat_messages WHERE channel_id = ? AND deleted_at IS NULL AND (author_id IS NULL OR author_id != ?) AND id > ?`;
      const binds: unknown[] = lastReadMessageId === null ? [channelId, userId] : [channelId, userId, lastReadMessageId];
      const r = await db.first<{ n: number }>(sql, ...binds);
      return r?.n ?? 0;
    },

    // ---- pins ----
    async listPinnedMessages(channelId: common.ChannelId): Promise<MessageRow[]> {
      // Join pins -> messages; exclude tombstones; newest-pinned message first (id desc).
      const rows = await db.all<MessageDbRow>(
        `SELECT m.* FROM chat_pins p
           JOIN chat_messages m ON m.id = p.message_id
          WHERE p.channel_id = ? AND m.deleted_at IS NULL
          ORDER BY m.id DESC`,
        channelId,
      );
      return rows.map(toMessageRow);
    },
    async isPinned(channelId: common.ChannelId, messageId: common.MessageId): Promise<boolean> {
      const r = await db.first<{ one: number }>(
        `SELECT 1 AS one FROM chat_pins WHERE channel_id = ? AND message_id = ?`,
        channelId, messageId,
      );
      return r !== null;
    },
    async addPin(channelId, messageId, userId, at): Promise<void> {
      await db.run(
        `INSERT INTO chat_pins (channel_id, message_id, pinned_by, pinned_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(channel_id, message_id) DO NOTHING`,
        channelId, messageId, userId, at,
      );
    },
    async removePin(channelId, messageId): Promise<boolean> {
      const res = await db.run(`DELETE FROM chat_pins WHERE channel_id = ? AND message_id = ?`, channelId, messageId);
      return res.meta.changes > 0;
    },

    // ---- search ----
    async searchMessages(q): Promise<SearchRow[]> {
      // Substring (case-insensitive over ASCII via lower(); CJK unaffected on both sides),
      // scoped to readable channels (public OR caller is a member). Newest-first, bounded.
      const where: string[] = [
        "m.deleted_at IS NULL",
        "instr(lower(m.body), ?) > 0",
        "(c.visibility = 'public' OR EXISTS (SELECT 1 FROM chat_channel_members mm WHERE mm.channel_id = c.id AND mm.user_id = ?))",
      ];
      const binds: unknown[] = [q.text.toLowerCase(), q.userId];
      if (q.channelId) {
        where.push("m.channel_id = ?");
        binds.push(q.channelId);
      }
      binds.push(q.limit);
      const rows = await db.all<MessageDbRow & { channel_name: string; channel_type: string }>(
        `SELECT m.*, c.name AS channel_name, c.type AS channel_type
           FROM chat_messages m
           JOIN chat_channels c ON c.id = m.channel_id
          WHERE ${where.join(" AND ")}
          ORDER BY m.id DESC LIMIT ?`,
        ...binds,
      );
      return rows.map((r) => ({
        message: toMessageRow(r),
        channelName: r.channel_name,
        channelType: r.channel_type as ChannelType,
      }));
    },

    // ---- deletion policy (org-scoped) ----
    async getDeletionPolicy(orgId): Promise<{ policy: { member: MessageDeletionMode; moderator: MessageDeletionMode; protectReacted: boolean }; version: number } | null> {
      let r: { deletion_member: string; deletion_moderator: string; protect_reacted: number; version: number } | null;
      try {
        r = await db.first<{ deletion_member: string; deletion_moderator: string; protect_reacted: number; version: number }>(
          `SELECT deletion_member, deletion_moderator, protect_reacted, version FROM chat_settings WHERE org_id = ?`,
          orgId,
        );
      } catch (err) {
        // Resilience: if the chat_settings migration (0003/0004) has not been applied to
        // this D1 yet (migrations run out-of-band, see deploy.yml), treat it exactly
        // like "no override row" -> the in-code default (all hard, protection off) is in
        // effect. Deletion must never 500 just because the settings table/column is
        // missing. Any OTHER error propagates (never silently change delete behaviour).
        if (/no such (table|column)/i.test(String((err as Error)?.message ?? err))) return null;
        throw err;
      }
      if (!r) return null;
      return {
        policy: {
          member: r.deletion_member as MessageDeletionMode,
          moderator: r.deletion_moderator as MessageDeletionMode,
          protectReacted: r.protect_reacted === 1,
        },
        version: r.version,
      };
    },
    async setDeletionPolicy(input): Promise<{ version: number } | null> {
      // UPDATE-then-INSERT upsert with optimistic-concurrency (mirrors addMember /
      // setReadState — "DO UPDATE SET" trips the @dub/db strict namespace guard).
      const protect = input.policy.protectReacted ? 1 : 0;
      if (input.expectedVersion === 0) {
        // First write: insert only if no row exists yet. A pre-existing row => conflict.
        const ins = await db.run(
          `INSERT OR IGNORE INTO chat_settings
             (org_id, deletion_member, deletion_moderator, protect_reacted, version, updated_at, updated_by)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
          input.orgId, input.policy.member, input.policy.moderator, protect, input.at, input.updatedBy,
        );
        return ins.meta.changes > 0 ? { version: 1 } : null;
      }
      const nextVersion = input.expectedVersion + 1;
      const upd = await db.run(
        `UPDATE chat_settings
            SET deletion_member = ?, deletion_moderator = ?, protect_reacted = ?, version = ?, updated_at = ?, updated_by = ?
          WHERE org_id = ? AND version = ?`,
        input.policy.member, input.policy.moderator, protect, nextVersion, input.at, input.updatedBy,
        input.orgId, input.expectedVersion,
      );
      return upd.meta.changes > 0 ? { version: nextVersion } : null;
    },
    async messageHasReactions(messageId: common.MessageId): Promise<boolean> {
      const r = await db.first<{ one: number }>(`SELECT 1 AS one FROM chat_reactions WHERE message_id = ? LIMIT 1`, messageId);
      return r !== null;
    },

    // ---- hard delete (physical removal + dependent-row cascade) ----
    async hardDeleteMessage(id: common.MessageId): Promise<void> {
      // Remove reactions/pins for the message AND any thread replies rooted at it,
      // then the replies, then the message itself. Same-namespace only; idempotent.
      await db.run(
        `DELETE FROM chat_reactions
          WHERE message_id = ? OR message_id IN (SELECT id FROM chat_messages WHERE thread_root_id = ?)`,
        id, id,
      );
      await db.run(
        `DELETE FROM chat_pins
          WHERE message_id = ? OR message_id IN (SELECT id FROM chat_messages WHERE thread_root_id = ?)`,
        id, id,
      );
      await db.run(`DELETE FROM chat_messages WHERE thread_root_id = ?`, id);
      await db.run(`DELETE FROM chat_messages WHERE id = ?`, id);
    },
  } satisfies ChatRepo;
}
