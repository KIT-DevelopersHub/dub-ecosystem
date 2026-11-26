// メンバーごとの times チャンネル自動作成 (#850). Dub チャット内のチャンネル (外部 Slack ではない).
//
// Each active Dub member gets one chat channel `<prefix><name>` (default `times-<name>`),
// created through ChatService.createChannel AS the member: created_by = the member, who is its
// only initial member with role admin (owner). Public by default. One D1 row per member
// (chat_times) means "this member has a times channel": both entry points skip it.
//
//   auto   identity.user.activated (identity-roster -> freeq outbox evt.chat -> freeq-drain ->
//          POST /internal/events-async). Event-driven, no polling. Off with CHAT_TIMES_AUTO=false.
//   bulk   admin preview (dry-run, nothing created) then POST /chat/times/bulk in bounded batches.
//
// Naming (@dub/types chat.timesBaseName): slug of the Dub display name (Japanese kept), else the
// email local part. A live non-DM channel with that name the member already created is adopted
// ('existing'); a name recorded for another member, any other channel with that name or an
// archived one moves on to `-2`, `-3`, ...
import type { D1Database } from "@cloudflare/workers-types";
import { errors } from "@dub/errors";
import { chat } from "@dub/types";
import type { ReqCtx } from "./service";
import type { Channel, CreateChannelRequest } from "./types";

type TimesConfig = chat.TimesConfig;
type TimesItem = chat.TimesItem;

/** Members per bulk call (each create = a few D1 writes + event/audit sends). */
export const TIMES_BULK_BATCH = 10;

/** The channel-creation code path (ChatService in production). */
export interface TimesChannelCreator {
  createChannel(ctx: ReqCtx, body: CreateChannelRequest, opts?: { system?: boolean }): Promise<Channel>;
}

export interface TimesDeps {
  db: D1Database;
  orgId: string;
  config: TimesConfig;
  now: () => string;
}

/** Env -> config. Unset / unparseable values fall back to the defaults. */
export function readTimesConfig(env: { CHAT_TIMES_PREFIX?: string; CHAT_TIMES_PRIVATE?: string; CHAT_TIMES_AUTO?: string }): TimesConfig {
  const prefix = chat.timesSlug(env.CHAT_TIMES_PREFIX ?? "", true);
  return {
    prefix: prefix || chat.TIMES_DEFAULT_PREFIX,
    isPrivate: env.CHAT_TIMES_PRIVATE === "true",
    autoCreate: env.CHAT_TIMES_AUTO !== "false",
  };
}

/** A non-DM chat channel whose name starts with the prefix. */
export interface ExistingChannel {
  id: string;
  createdBy: string;
  archived: boolean;
}

export type NamePlan = { kind: "existing"; name: string; channelId: string } | { kind: "create"; name: string };

/**
 * Pick the name: the first of base, base-2, … not recorded for another member and not used by
 * any channel — except a live channel the member created themself, which is adopted.
 */
export function planTimesName(
  base: string,
  userId: string,
  channels: ReadonlyMap<string, readonly ExistingChannel[]>,
  takenByOthers: ReadonlySet<string>,
  skip: ReadonlySet<string> = new Set(),
): NamePlan {
  for (let i = 1; i <= chat.TIMES_MAX_SUFFIX; i++) {
    const name = chat.timesCandidate(base, i);
    if (takenByOthers.has(name) || skip.has(name)) continue;
    const same = channels.get(name) ?? [];
    if (same.length === 0) return { kind: "create", name };
    const own = same.find((c) => !c.archived && c.createdBy === userId);
    if (own) return { kind: "existing", name, channelId: own.id };
  }
  throw errors.conflict(`times channel name exhausted: ${base}`, { reason: "name_exhausted" });
}

interface MemberRow {
  id: string;
  display_name: string;
  email: string;
}

interface RecordRow {
  user_id: string;
  channel_name: string;
}

const MEMBER_SQL = `SELECT id, display_name, email FROM identity_users
  WHERE org_id = ? AND status = 'active' AND email NOT LIKE '%@slack-import.invalid'`;

export class Times {
  constructor(private readonly d: TimesDeps) {}

  get config(): TimesConfig {
    return this.d.config;
  }

  /** Active, real (non Slack-import placeholder) members of the org. */
  private async members(): Promise<MemberRow[]> {
    const res = await this.d.db.prepare(`${MEMBER_SQL} ORDER BY display_name, id`).bind(this.d.orgId).all<MemberRow>();
    return res.results ?? [];
  }

  private async records(): Promise<RecordRow[]> {
    const res = await this.d.db
      .prepare(`SELECT user_id, channel_name FROM chat_times WHERE org_id = ?`)
      .bind(this.d.orgId)
      .all<RecordRow>();
    return res.results ?? [];
  }

  /** Non-DM channels whose name starts with the prefix, grouped by name. */
  private async channels(): Promise<Map<string, ExistingChannel[]>> {
    const prefix = this.d.config.prefix;
    const res = await this.d.db
      .prepare(`SELECT id, name, created_by, archived_at FROM chat_channels WHERE type != 'dm' AND substr(name, 1, ?) = ?`)
      .bind(prefix.length, prefix)
      .all<{ id: string; name: string; created_by: string; archived_at: string | null }>();
    const map = new Map<string, ExistingChannel[]>();
    for (const r of res.results ?? []) {
      const list = map.get(r.name) ?? [];
      list.push({ id: r.id, createdBy: r.created_by, archived: r.archived_at !== null });
      map.set(r.name, list);
    }
    return map;
  }

  private base(m: MemberRow): string {
    return chat.timesBaseName(this.d.config.prefix, { displayName: m.display_name, email: m.email });
  }

  private item(m: MemberRow, over: Partial<TimesItem>): TimesItem {
    return { userId: m.id, displayName: m.display_name, email: m.email, channelName: null, channelId: null, status: "planned", error: null, ...over };
  }

  /** Dry run: who has no recorded times channel, and the name they would get. No writes. */
  async preview(): Promise<chat.TimesPreviewResponse> {
    const [members, records, channels] = await Promise.all([this.members(), this.records(), this.channels()]);
    const recordedUsers = new Set(records.map((r) => r.user_id));
    const taken = new Set(records.map((r) => r.channel_name));
    const items: TimesItem[] = [];
    for (const m of members) {
      if (recordedUsers.has(m.id)) continue;
      const plan = planTimesName(this.base(m), m.id, channels, taken);
      taken.add(plan.name); // two members in one preview must not get the same name
      items.push(
        this.item(m, {
          channelName: plan.name,
          channelId: plan.kind === "existing" ? plan.channelId : null,
          status: plan.kind === "existing" ? "existing" : "planned",
        }),
      );
    }
    return { config: this.d.config, items, recordedCount: recordedUsers.size };
  }

  /** Create for up to TIMES_BULK_BATCH members (optionally only `userIds`). Re-callable. */
  async bulk(creator: TimesChannelCreator, requestId: string, userIds?: readonly string[]): Promise<chat.TimesBulkResponse> {
    const [members, records] = await Promise.all([this.members(), this.records()]);
    const recordedUsers = new Set(records.map((r) => r.user_id));
    const wanted = userIds ? new Set(userIds) : null;
    const todo = members.filter((m) => !recordedUsers.has(m.id) && (!wanted || wanted.has(m.id)));
    if (todo.length === 0) return { results: [], remaining: 0 };
    const channels = await this.channels();
    const taken = new Set(records.map((r) => r.channel_name));
    const results: TimesItem[] = [];
    for (const m of todo.slice(0, TIMES_BULK_BATCH)) {
      try {
        results.push(await this.ensure(creator, requestId, m, channels, taken));
      } catch (e) {
        // One member's failure must not stop the batch; it stays unrecorded and is retried.
        results.push(this.item(m, { status: "failed", error: e instanceof Error ? e.message : String(e) }));
      }
    }
    return { results, remaining: Math.max(0, todo.length - TIMES_BULK_BATCH) };
  }

  /** Event path: one member, by id. Recorded / inactive / unknown -> no-op. Errors throw (retry). */
  async ensureForUser(creator: TimesChannelCreator, requestId: string, userId: string): Promise<TimesItem | null> {
    const row = await this.d.db.prepare(`${MEMBER_SQL} AND id = ?`).bind(this.d.orgId, userId).first<MemberRow>();
    if (!row) return null;
    const records = await this.records();
    if (records.some((r) => r.user_id === userId)) return this.item(row, { status: "recorded" });
    return this.ensure(creator, requestId, row, await this.channels(), new Set(records.map((r) => r.channel_name)));
  }

  /** Plan -> reserve the row -> create through ChatService -> fill channel_id. */
  private async ensure(
    creator: TimesChannelCreator,
    requestId: string,
    m: MemberRow,
    channels: ReadonlyMap<string, readonly ExistingChannel[]>,
    taken: Set<string>,
  ): Promise<TimesItem> {
    const base = this.base(m);
    const tried = new Set<string>();
    for (;;) {
      const plan = planTimesName(base, m.id, channels, taken, tried);
      const reserved = await this.reserve(m.id, plan.kind === "existing" ? plan.channelId : "", plan.name, plan.kind === "existing" ? "existing" : "created");
      if (!reserved) {
        // Lost a race: either this member was recorded meanwhile, or another member took the name.
        if (await this.isRecorded(m.id)) return this.item(m, { status: "recorded" });
        tried.add(plan.name);
        continue;
      }
      taken.add(plan.name);
      if (plan.kind === "existing") return this.item(m, { channelName: plan.name, channelId: plan.channelId, status: "existing" });
      let created: Channel;
      try {
        created = await creator.createChannel(
          { requestId, userId: m.id },
          { type: "topic", visibility: this.d.config.isPrivate ? "private" : "public", name: plan.name, topic: `${m.display_name} の times` },
          { system: true },
        );
      } catch (e) {
        await this.d.db.prepare(`DELETE FROM chat_times WHERE org_id = ? AND user_id = ? AND channel_id = ''`).bind(this.d.orgId, m.id).run();
        throw e;
      }
      await this.d.db.prepare(`UPDATE chat_times SET channel_id = ? WHERE org_id = ? AND user_id = ?`).bind(created.id, this.d.orgId, m.id).run();
      return this.item(m, { channelName: plan.name, channelId: created.id, status: "created" });
    }
  }

  private async isRecorded(userId: string): Promise<boolean> {
    const r = await this.d.db.prepare(`SELECT 1 AS x FROM chat_times WHERE org_id = ? AND user_id = ?`).bind(this.d.orgId, userId).first();
    return r !== null;
  }

  /** INSERT OR IGNORE; false when the member or the name was recorded concurrently. */
  private async reserve(userId: string, channelId: string, name: string, status: "created" | "existing"): Promise<boolean> {
    const r = await this.d.db
      .prepare(`INSERT OR IGNORE INTO chat_times (org_id, user_id, channel_id, channel_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(this.d.orgId, userId, channelId, name, status, this.d.now())
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }
}
