// Slack times チャンネルの自動作成 (#850).
//
// Each active Dub member gets one Slack channel `<prefix><name>` (default `times-<name>`),
// created by the LMB bot and with the member invited. One D1 row per member
// (chat_slack_times) means "this member has a times channel": both entry points skip it.
//
//   auto   identity.user.activated (identity-roster -> freeq outbox evt.chat -> freeq-drain ->
//          POST /internal/events-async). Event-driven, no polling. Off with SLACK_TIMES_AUTO=false.
//   bulk   admin preview (dry-run, no Slack writes) then POST …/bulk in bounded batches.
//
// Slack account join = the member's Dub email (users.list / users.lookupByEmail), the same
// join the channel import uses. No Slack account yet -> nothing is created (the bulk action
// covers it later).
//
// Naming: slug of the Slack display name -> real name -> username -> Dub display name ->
// email local part (first non-empty). A name already in Slack (not archived) is treated as the
// member's existing times channel and only recorded; a name recorded for ANOTHER member, an
// archived channel or Slack's name_taken moves on to `-2`, `-3`, ...
import type { D1Database } from "@cloudflare/workers-types";
import { CommonErrorCodes, DubError, errors } from "@dub/errors";
import { type SlackChannel, type SlackUser, SlackApiError } from "@dub/slack-import";
import { chat } from "@dub/types";

type SlackTimesConfig = chat.SlackTimesConfig;
type SlackTimesItem = chat.SlackTimesItem;

/** Members per bulk call: 1-4 list calls + 2 writes each stays well under 50 subrequests. */
export const SLACK_TIMES_BULK_BATCH = 10;
const SLACK_CHANNEL_NAME_MAX = 80;
const MAX_SUFFIX = 20;
const NAME_TAKEN_RETRIES = 3;

/** The Slack client surface this module needs (a fake in tests; never the network). */
export interface SlackTimesClient {
  listUsers(): Promise<SlackUser[]>;
  listChannels(types?: string): Promise<SlackChannel[]>;
  lookupUserByEmail(email: string): Promise<SlackUser | null>;
  createChannel(name: string, isPrivate: boolean): Promise<SlackChannel>;
  inviteToChannel(channelId: string, userIds: readonly string[]): Promise<void>;
}

export interface SlackTimesDeps {
  db: D1Database;
  slack: SlackTimesClient | null;
  orgId: string;
  config: SlackTimesConfig;
  now: () => string;
}

/** Env -> config. Unset / unparseable values fall back to the defaults. */
export function readSlackTimesConfig(env: {
  SLACK_TIMES_PREFIX?: string;
  SLACK_TIMES_PRIVATE?: string;
  SLACK_TIMES_AUTO?: string;
}): SlackTimesConfig {
  const prefix = slugForChannel(env.SLACK_TIMES_PREFIX ?? "", true);
  return {
    prefix: prefix || "times-",
    isPrivate: env.SLACK_TIMES_PRIVATE === "true",
    autoCreate: env.SLACK_TIMES_AUTO !== "false",
  };
}

/**
 * Slack-safe slug: NFKC, lowercase, anything but letters / digits / `_` / `-` becomes `-`,
 * runs collapsed, leading/trailing `-` trimmed (a prefix keeps its trailing separator).
 * Letters include non-Latin scripts (Slack accepts e.g. Japanese channel names).
 */
export function slugForChannel(raw: string, keepTrailing = false): string {
  let s = raw.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/-{2,}/g, "-");
  s = s.replace(/^-+/, "");
  if (!keepTrailing) s = s.replace(/[-_]+$/, "");
  return s;
}

/** The base channel name for a member (no collision suffix yet). */
export function baseTimesName(
  prefix: string,
  member: { displayName: string; email: string },
  slackUser: SlackUser | null,
): string {
  const candidates = [
    slackUser?.profile?.display_name,
    slackUser?.profile?.real_name,
    slackUser?.real_name,
    slackUser?.name,
    member.displayName,
    member.email.split("@")[0],
  ];
  const room = SLACK_CHANNEL_NAME_MAX - prefix.length - 3; // keep room for "-NN"
  for (const c of candidates) {
    const slug = c ? slugForChannel(c).slice(0, room).replace(/[-_]+$/, "") : "";
    if (slug) return `${prefix}${slug}`;
  }
  return `${prefix}member`;
}

export type NamePlan = { kind: "existing"; name: string; channelId: string } | { kind: "create"; name: string };

/**
 * Pick the name: the first of base, base-2, base-3 … not recorded for another member and not
 * an archived Slack channel. A live Slack channel with that name = the member's existing one.
 */
export function planTimesName(
  base: string,
  slackChannels: ReadonlyMap<string, { id: string; archived: boolean }>,
  takenByOthers: ReadonlySet<string>,
  skip: ReadonlySet<string> = new Set(),
): NamePlan {
  for (let i = 1; i <= MAX_SUFFIX; i++) {
    const name = i === 1 ? base : `${base}-${i}`;
    if (takenByOthers.has(name) || skip.has(name)) continue;
    const ch = slackChannels.get(name);
    if (ch && ch.archived) continue;
    if (ch) return { kind: "existing", name, channelId: ch.id };
    return { kind: "create", name };
  }
  throw errors.conflict(`times channel name exhausted: ${base}`, { reason: "name_exhausted" });
}

/** missing_scope / not_allowed_token_type -> one admin-facing 412 naming every needed scope. */
export function slackScopeError(e: SlackApiError): DubError {
  return new DubError(
    CommonErrorCodes.PRECONDITION_FAILED,
    `Slack アプリの権限が足りません（${e.method}）。Slack アプリの OAuth & Permissions で次の Bot Token Scopes を追加し、再インストールしてください: ${chat.SLACK_TIMES_REQUIRED_SCOPES.join(", ")}`,
    {
      details: {
        reason: "slack_missing_scope",
        method: e.method,
        needed: e.needed,
        neededScopes: [...chat.SLACK_TIMES_REQUIRED_SCOPES],
      },
    },
  );
}

const SCOPE_ERRORS = new Set(["missing_scope", "not_allowed_token_type", "no_permission"]);

/** Map a Slack failure to the admin-facing error the routes surface. */
function toDubError(e: unknown): unknown {
  if (!(e instanceof SlackApiError)) return e;
  if (SCOPE_ERRORS.has(e.slackError)) return slackScopeError(e);
  if (e.slackError === "rate_limited") return errors.rateLimited(e.retryAfterSec ?? 30);
  if (e.slackError === "invalid_auth" || e.slackError === "not_authed" || e.slackError === "token_revoked") {
    return new DubError(CommonErrorCodes.PRECONDITION_FAILED, "Slack のトークンが無効です。SLACK_BOT_TOKEN を確認してください。", {
      details: { reason: `slack_${e.slackError}` },
    });
  }
  return e;
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

/** Slack's lists, loaded once per request. */
interface SlackSnapshot {
  usersByEmail: Map<string, SlackUser>;
  channels: Map<string, { id: string; archived: boolean }>;
}

export class SlackTimes {
  constructor(private readonly d: SlackTimesDeps) {}

  get config(): SlackTimesConfig {
    return this.d.config;
  }

  private client(): SlackTimesClient {
    if (!this.d.slack) throw errors.preconditionFailed("slack_times_not_configured");
    return this.d.slack;
  }

  /** Active, real (non Slack-import placeholder) members of the org. */
  private async members(): Promise<MemberRow[]> {
    const res = await this.d.db
      .prepare(
        `SELECT id, display_name, email FROM identity_users
         WHERE org_id = ? AND status = 'active' AND email NOT LIKE '%@slack-import.invalid'
         ORDER BY display_name, id`,
      )
      .bind(this.d.orgId)
      .all<MemberRow>();
    return res.results ?? [];
  }

  private async records(): Promise<RecordRow[]> {
    const res = await this.d.db
      .prepare(`SELECT user_id, channel_name FROM chat_slack_times WHERE org_id = ?`)
      .bind(this.d.orgId)
      .all<RecordRow>();
    return res.results ?? [];
  }

  private async snapshot(): Promise<SlackSnapshot> {
    const slack = this.client();
    try {
      const [users, channels] = await Promise.all([slack.listUsers(), slack.listChannels("public_channel,private_channel")]);
      const usersByEmail = new Map<string, SlackUser>();
      for (const u of users) {
        if (u.deleted || u.is_bot || !u.profile?.email) continue;
        usersByEmail.set(u.profile.email.toLowerCase(), u);
      }
      const chans = new Map<string, { id: string; archived: boolean }>();
      for (const c of channels) chans.set(c.name, { id: c.id, archived: (c as { is_archived?: boolean }).is_archived === true });
      return { usersByEmail, channels: chans };
    } catch (e) {
      throw toDubError(e);
    }
  }

  private item(m: MemberRow, over: Partial<SlackTimesItem>): SlackTimesItem {
    return {
      userId: m.id,
      displayName: m.display_name,
      email: m.email,
      channelName: null,
      slackUserId: null,
      slackChannelId: null,
      status: "planned",
      error: null,
      ...over,
    };
  }

  /** Dry run: who has no recorded times channel, and what would happen. No Slack writes. */
  async preview(): Promise<chat.SlackTimesPreviewResponse> {
    const [members, records] = await Promise.all([this.members(), this.records()]);
    const recordedUsers = new Set(records.map((r) => r.user_id));
    const taken = new Set(records.map((r) => r.channel_name));
    const snap = await this.snapshot();
    const items: SlackTimesItem[] = [];
    for (const m of members) {
      if (recordedUsers.has(m.id)) continue;
      const su = snap.usersByEmail.get(m.email.toLowerCase()) ?? null;
      if (!su) {
        items.push(this.item(m, { status: "no_slack_account" }));
        continue;
      }
      const plan = planTimesName(baseTimesName(this.d.config.prefix, { displayName: m.display_name, email: m.email }, su), snap.channels, taken);
      taken.add(plan.name); // two members in one preview must not get the same name
      items.push(
        this.item(m, {
          channelName: plan.name,
          slackUserId: su.id,
          slackChannelId: plan.kind === "existing" ? plan.channelId : null,
          status: plan.kind === "existing" ? "existing" : "planned",
        }),
      );
    }
    return { config: this.d.config, items, recordedCount: recordedUsers.size };
  }

  /** Create for up to SLACK_TIMES_BULK_BATCH members (optionally only `userIds`). Re-callable. */
  async bulk(userIds?: readonly string[]): Promise<chat.SlackTimesBulkResponse> {
    const [members, records] = await Promise.all([this.members(), this.records()]);
    const recordedUsers = new Set(records.map((r) => r.user_id));
    const wanted = userIds ? new Set(userIds) : null;
    const todo = members.filter((m) => !recordedUsers.has(m.id) && (!wanted || wanted.has(m.id)));
    if (todo.length === 0) return { results: [], remaining: 0 };
    const snap = await this.snapshot();
    const taken = new Set(records.map((r) => r.channel_name));
    const results: SlackTimesItem[] = [];
    let processed = 0;
    for (const m of todo) {
      if (processed >= SLACK_TIMES_BULK_BATCH) break;
      const su = snap.usersByEmail.get(m.email.toLowerCase()) ?? null;
      if (!su) {
        // Not a Slack write: report it, but it does not use up the batch.
        results.push(this.item(m, { status: "no_slack_account" }));
        continue;
      }
      processed++;
      results.push(await this.ensure(m, su, snap.channels, taken));
    }
    // Members with a Slack account not handled by this call. A failed member stays unrecorded
    // and is retried by the next call; the UI stops when a call makes no progress.
    const withAccount = todo.filter((m) => snap.usersByEmail.has(m.email.toLowerCase())).length;
    const remaining = Math.max(0, withAccount - processed);
    return { results, remaining };
  }

  /** Event path: one member, by id. Recorded / inactive / no Slack account -> no-op. */
  async ensureForUser(userId: string): Promise<SlackTimesItem | null> {
    const row = await this.d.db
      .prepare(
        `SELECT id, display_name, email FROM identity_users
         WHERE id = ? AND org_id = ? AND status = 'active' AND email NOT LIKE '%@slack-import.invalid'`,
      )
      .bind(userId, this.d.orgId)
      .first<MemberRow>();
    if (!row) return null;
    const records = await this.records();
    if (records.some((r) => r.user_id === userId)) return this.item(row, { status: "recorded" });
    const slack = this.client();
    let su: SlackUser | null;
    let channels: SlackChannel[];
    try {
      su = await slack.lookupUserByEmail(row.email);
      if (!su) return this.item(row, { status: "no_slack_account" });
      channels = await slack.listChannels("public_channel,private_channel");
    } catch (e) {
      throw toDubError(e);
    }
    const map = new Map(channels.map((c) => [c.name, { id: c.id, archived: (c as { is_archived?: boolean }).is_archived === true }] as const));
    const result = await this.ensure(row, su, map, new Set(records.map((r) => r.channel_name)));
    if (result.status === "failed") throw errors.conflict(result.error ?? "slack times failed", { reason: "slack_times_failed" });
    return result;
  }

  /** Plan -> create (name_taken -> next suffix) -> record -> invite. Scope / auth / 429 throw. */
  private async ensure(
    m: MemberRow,
    su: SlackUser,
    channels: ReadonlyMap<string, { id: string; archived: boolean }>,
    taken: Set<string>,
  ): Promise<SlackTimesItem> {
    const slack = this.client();
    const base = baseTimesName(this.d.config.prefix, { displayName: m.display_name, email: m.email }, su);
    const tried = new Set<string>();
    for (let attempt = 0; attempt <= NAME_TAKEN_RETRIES; attempt++) {
      const plan = planTimesName(base, channels, taken, tried);
      if (plan.kind === "existing") {
        const ok = await this.record(m.id, su.id, plan.channelId, plan.name, "existing");
        if (!ok) {
          tried.add(plan.name);
          continue;
        }
        taken.add(plan.name);
        return this.item(m, { channelName: plan.name, slackUserId: su.id, slackChannelId: plan.channelId, status: "existing" });
      }
      let created: SlackChannel;
      try {
        created = await slack.createChannel(plan.name, this.d.config.isPrivate);
      } catch (e) {
        if (e instanceof SlackApiError && e.slackError === "name_taken") {
          tried.add(plan.name);
          continue;
        }
        const mapped = toDubError(e);
        if (mapped instanceof SlackApiError) {
          return this.item(m, { channelName: plan.name, slackUserId: su.id, status: "failed", error: `Slack API エラー: ${mapped.slackError}` });
        }
        throw mapped;
      }
      taken.add(plan.name);
      await this.record(m.id, su.id, created.id, plan.name, "created");
      try {
        await slack.inviteToChannel(created.id, [su.id]);
      } catch (e) {
        const mapped = toDubError(e);
        const msg = mapped instanceof DubError ? mapped.message : e instanceof SlackApiError ? `Slack API エラー: ${e.slackError}` : String(e);
        // The channel exists and is recorded; only the invite is missing. Surface it.
        return this.item(m, { channelName: plan.name, slackUserId: su.id, slackChannelId: created.id, status: "failed", error: `作成済み・招待に失敗: ${msg}` });
      }
      return this.item(m, { channelName: plan.name, slackUserId: su.id, slackChannelId: created.id, status: "created" });
    }
    return this.item(m, { channelName: null, slackUserId: su.id, status: "failed", error: "チャンネル名が他と重複し続けたため作成できませんでした" });
  }

  /** INSERT OR IGNORE; false when the member or the name was recorded concurrently. */
  private async record(userId: string, slackUserId: string, channelId: string, name: string, status: "created" | "existing"): Promise<boolean> {
    const r = await this.d.db
      .prepare(
        `INSERT OR IGNORE INTO chat_slack_times (org_id, user_id, slack_user_id, slack_channel_id, channel_name, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(this.d.orgId, userId, slackUserId, channelId, name, status, this.d.now())
      .run();
    return (r.meta?.changes ?? 0) > 0;
  }
}
