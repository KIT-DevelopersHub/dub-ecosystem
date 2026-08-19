// Demo seed scenarios (#29 contract). Idempotent by fixed prefix-ULID ids
// (INSERT OR REPLACE; audit_logs uses INSERT OR IGNORE to respect its append-only
// trigger). `isolate: true` suffixes generated ids with a runId so a shared preview D1
// can seed concurrently and each run's cleanup() removes only its own rows.
//
// Prod guard is by database_name (theme-12): passing databaseName === "dub-core"
// throws SEED_ENV_FORBIDDEN — env self-report is never trusted.
import type { D1Database } from "@cloudflare/workers-types";
import { DubError } from "@dub/errors";
import { ulid, nowIso } from "@dub/db";
import { PROD_DB_NAME } from "../src/errors";
import { SEED, SEED_TS, SEED_AUDIT_TS, fixtureHash, type TestUserKey } from "./fixtures";

export type SeedScenarioName = "minimal" | "conference-demo" | "rbac-matrix";
export type { TestUserKey };

export interface SeedScenarioOptions {
  /** true = suffix generated ids with runId for concurrent preview seeding. */
  isolate?: boolean;
  /** database_name of the target D1; "dub-core" (prod) is rejected. */
  databaseName?: string;
}

export interface SeedHandle {
  runId: string; // "fixed" when isolate is false, else a ULID
  scenario: SeedScenarioName;
  inserted: number;
  cleanup(): Promise<void>;
}

interface DeleteSpec {
  table: string;
  where: Record<string, unknown>;
}

class Writer {
  inserted = 0;
  private readonly deletes: DeleteSpec[] = [];
  constructor(private readonly db: D1Database) {}

  async upsert(table: string, row: Record<string, unknown>, mode: "replace" | "ignore", key: string[]): Promise<void> {
    const cols = Object.keys(row);
    const sql = `INSERT OR ${mode === "replace" ? "REPLACE" : "IGNORE"} INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
    await this.db
      .prepare(sql)
      .bind(...cols.map((c) => row[c] ?? null))
      .run();
    this.inserted += 1;
    const where: Record<string, unknown> = {};
    for (const k of key) where[k] = row[k];
    this.deletes.push({ table, where });
  }

  async cleanup(): Promise<void> {
    // reverse insertion order = FK-safe (children before parents).
    for (const d of [...this.deletes].reverse()) {
      const keys = Object.keys(d.where);
      const sql = `DELETE FROM ${d.table} WHERE ${keys.map((k) => `${k} = ?`).join(" AND ")}`;
      await this.db
        .prepare(sql)
        .bind(...keys.map((k) => d.where[k] ?? null))
        .run();
    }
  }
}

export async function seedScenario(db: D1Database, name: SeedScenarioName, opts: SeedScenarioOptions = {}): Promise<SeedHandle> {
  if (opts.databaseName === PROD_DB_NAME) {
    throw new DubError("SEED_ENV_FORBIDDEN", `refusing to seed the prod database "${PROD_DB_NAME}"`, { status: 403 });
  }

  const isolate = name !== "minimal" && opts.isolate === true; // minimal is fixed-only (design §2-4)
  const runId = isolate ? ulid() : "fixed";
  const sfx = isolate ? `_${runId}` : "";
  const w = new Writer(db);

  const userKeys: TestUserKey[] = name === "minimal" ? ["admin", "member"] : ["admin", "organizer", "member"];
  const withOutsider = name === "rbac-matrix";
  const taskCount = name === "minimal" ? 2 : 10;

  const adminId = SEED.users.admin.id + sfx;

  // 1. outsider org + role (rbac-matrix only). Primary org + system roles come from the
  //    identity migration, so we never re-create them here.
  if (withOutsider) {
    const outOrgId = SEED.orgs.outsider.id + sfx;
    await w.upsert("identity_orgs", { id: outOrgId, name: SEED.orgs.outsider.name, created_at: SEED_TS }, "replace", ["id"]);
    await w.upsert(
      "identity_roles",
      { id: SEED.outsiderRoleId + sfx, org_id: outOrgId, name: "member", is_system: 1, created_at: SEED_TS, updated_at: SEED_TS },
      "replace",
      ["id"],
    );
  }

  // 2. demo users + role assignments.
  for (const key of userKeys) {
    const u = SEED.users[key];
    const uid = u.id + sfx;
    const local = u.email.split("@")[0];
    const domain = u.email.split("@")[1];
    const email = isolate ? `${local}+${runId}@${domain}` : u.email;
    await w.upsert(
      "identity_users",
      { id: uid, org_id: SEED.orgs.primary.id, email, display_name: u.displayName, github_login: null, avatar_url: null, status: "active", created_at: SEED_TS, updated_at: SEED_TS },
      "replace",
      ["id"],
    );
    const roleId = SEED.roleIds[u.role];
    await w.upsert(
      "identity_role_assignments",
      { id: `ra_${key}${sfx}`, user_id: uid, role_id: roleId, org_id: SEED.orgs.primary.id, resource_type: null, resource_id: null, granted_by: adminId, granted_at: SEED_TS },
      "replace",
      ["id"],
    );
  }
  if (withOutsider) {
    const ou = SEED.users.outsider;
    const ouid = ou.id + sfx;
    const outOrgId = SEED.orgs.outsider.id + sfx;
    const local = ou.email.split("@")[0];
    const domain = ou.email.split("@")[1];
    const email = isolate ? `${local}+${runId}@${domain}` : ou.email;
    await w.upsert(
      "identity_users",
      { id: ouid, org_id: outOrgId, email, display_name: ou.displayName, github_login: null, avatar_url: null, status: "active", created_at: SEED_TS, updated_at: SEED_TS },
      "replace",
      ["id"],
    );
    await w.upsert(
      "identity_role_assignments",
      { id: `ra_outsider${sfx}`, user_id: ouid, role_id: SEED.outsiderRoleId + sfx, org_id: outOrgId, resource_type: null, resource_id: null, granted_by: ouid, granted_at: SEED_TS },
      "replace",
      ["id"],
    );
  }

  // 3. event + actions.
  const eventId = SEED.event.id + sfx;
  await w.upsert(
    "event_events",
    { id: eventId, org_id: SEED.orgs.primary.id, title: SEED.event.name, description: "Seeded demo conference", phase: "planning", starts_at: "2026-08-05T00:00:00.000Z", ends_at: "2026-08-06T00:00:00.000Z", version: 1, archived_at: null, created_by: adminId, created_at: SEED_TS, updated_at: SEED_TS },
    "replace",
    ["id"],
  );
  const actionSpecs: Array<[string, string]> =
    name === "minimal" ? [["venue", SEED.actions.venue]] : [["venue", SEED.actions.venue], ["sponsor", SEED.actions.sponsor]];
  for (let i = 0; i < actionSpecs.length; i++) {
    const [kind, baseId] = actionSpecs[i]!;
    await w.upsert(
      "event_actions",
      { id: baseId + sfx, event_id: eventId, kind, title: `${kind} action`, sort_order: i, version: 1, archived_at: null, created_by: adminId, created_at: SEED_TS, updated_at: SEED_TS },
      "replace",
      ["id"],
    );
  }

  // 4. tasks (+ 2 dependencies). status/priority/assignee spread across users.
  const statuses = ["todo", "in_progress", "blocked", "done", "todo", "in_progress", "todo", "done", "todo", "blocked"];
  const priorities = ["high", "medium", "urgent", "low", "medium", "high", "low", "medium", "high", "urgent"];
  const assignees = userKeys.map((k) => SEED.users[k].id + sfx);
  const taskIds: string[] = [];
  for (let i = 0; i < taskCount; i++) {
    const id = i === 0 ? SEED.tasks.root + sfx : i === 1 ? SEED.tasks.blocked + sfx : `task_seed_${String(i).padStart(2, "0")}${sfx}`;
    taskIds.push(id);
    await w.upsert(
      "task_tasks",
      // Staggered due dates (Aug 5 + 2·i days) so the gantt renders real, spread-out
      // bars; combined with priority-driven durations this yields a legible chart.
      { id, event_id: eventId, title: `Demo task ${i + 1}`, description: null, status: statuses[i % statuses.length], priority: priorities[i % priorities.length], assignee_id: assignees[i % assignees.length], due_at: new Date(Date.UTC(2026, 7, 5 + i * 2)).toISOString(), origin: "internal", version: 1, due_soon_notified_at: null, created_by: adminId, created_at: SEED_TS, updated_at: SEED_TS, archived_at: null },
      "replace",
      ["id"],
    );
  }
  // blocked -> root, and (if present) task_03 -> root
  const depPairs: Array<[string, string]> = [[taskIds[1]!, taskIds[0]!]];
  if (taskIds.length > 2) depPairs.push([taskIds[2]!, taskIds[0]!]);
  for (const [taskId, dependsOn] of depPairs) {
    await w.upsert("task_dependencies", { task_id: taskId, depends_on_id: dependsOn, created_at: SEED_TS }, "replace", ["task_id", "depends_on_id"]);
  }

  // 5. notifications / inbox / preferences (conference-demo + rbac only).
  if (name !== "minimal") {
    const notifSpecs = [
      { id: `notif_seed_01${sfx}`, user: "admin", read: true },
      { id: `notif_seed_02${sfx}`, user: "organizer", read: false },
      { id: `notif_seed_03${sfx}`, user: "member", read: false },
    ];
    for (let i = 0; i < notifSpecs.length; i++) {
      const s = notifSpecs[i]!;
      await w.upsert(
        "notif_notifications",
        { id: s.id, type: "task.assigned", title: `Task assigned #${i + 1}`, body: "You have a new task", priority: "normal", dedup_key: null, source: "queue", source_event: "task.assigned", actor_id: adminId, request_id: `req_seed_${i}`, resource_type: "task", resource_id: taskIds[i % taskIds.length]!, meta_json: "{}", created_at: SEED_TS },
        "replace",
        ["id"],
      );
      const uid = SEED.users[s.user as TestUserKey].id + sfx;
      await w.upsert(
        "notif_inbox",
        { id: `inbox_seed_${i}${sfx}`, notification_id: s.id, user_id: uid, read_at: s.read ? SEED_TS : null, created_at: SEED_TS },
        "replace",
        ["id"],
      );
    }
    for (const key of userKeys) {
      const uid = SEED.users[key].id + sfx;
      await w.upsert(
        "notif_preferences",
        { user_id: uid, type: "*", channel: "in_app", enabled: 1, updated_at: SEED_TS },
        "replace",
        ["user_id", "type", "channel"],
      );
    }

    // 6. files + links.
    for (let i = 0; i < 3; i++) {
      const fid = `file_seed_${i}${sfx}`;
      await w.upsert(
        "file_meta_files",
        { id: fid, name: `demo-${i}.pdf`, mime_type: "application/pdf", size_bytes: 1024 * (i + 1), owner_id: adminId, visibility: "org", drive_file_id: null, r2_key: `seed/demo-${i}${sfx}.pdf`, archived_at: null, created_by: adminId, created_at: SEED_TS, updated_at: SEED_TS },
        "replace",
        ["id"],
      );
      const target = i === 0 ? { type: "event", id: eventId } : { type: "task", id: taskIds[i % taskIds.length]! };
      await w.upsert(
        "file_meta_links",
        { file_id: fid, target_type: target.type, target_id: target.id, linked_by: adminId, linked_at: SEED_TS, archived_at: null },
        "replace",
        ["file_id", "target_type", "target_id"],
      );
    }

    // 6b. chat channel + members + a short threaded conversation (chat is a DRAFT
    //     namespace with no cross-namespace FK, so user/event ids are plain references).
    const channelId = SEED.channel.general + sfx;
    await w.upsert(
      "chat_channels",
      { id: channelId, type: "event", visibility: "public", name: "general", topic: "Conference-wide chatter", event_id: eventId, dm_key: null, created_by: adminId, archived_at: null, version: 1, created_at: SEED_TS, updated_at: SEED_TS },
      "replace",
      ["id"],
    );
    for (const key of userKeys) {
      const uid = SEED.users[key].id + sfx;
      await w.upsert(
        "chat_channel_members",
        { channel_id: channelId, user_id: uid, role: key === "admin" ? "admin" : "member", joined_at: SEED_TS },
        "replace",
        ["channel_id", "user_id"],
      );
    }
    const memberId = SEED.users.member.id + sfx;
    const systemMsgId = SEED.messages.system + sfx;
    const welcomeMsgId = SEED.messages.welcome + sfx;
    const replyMsgId = SEED.messages.reply + sfx;
    const messageSpecs = [
      { id: systemMsgId, author: null, kind: "system", body: "Channel #general created.", thread: null },
      { id: welcomeMsgId, author: adminId, kind: "user", body: "Welcome to the Hokuriku IT Conference channel!", thread: null },
      { id: replyMsgId, author: memberId, kind: "user", body: "Thanks — excited to help out.", thread: welcomeMsgId },
    ];
    for (const m of messageSpecs) {
      await w.upsert(
        "chat_messages",
        { id: m.id, channel_id: channelId, thread_root_id: m.thread, author_id: m.author, kind: m.kind, body: m.body, attachment_file_ids: "[]", version: 1, edited_at: null, deleted_at: null, created_at: SEED_TS },
        "replace",
        ["id"],
      );
    }
    // one reaction on the welcome message, and per-user read states pinned to the reply.
    await w.upsert(
      "chat_reactions",
      { message_id: welcomeMsgId, emoji: "👍", user_id: SEED.users.organizer.id + sfx, created_at: SEED_TS },
      "replace",
      ["message_id", "emoji", "user_id"],
    );
    for (const key of userKeys) {
      const uid = SEED.users[key].id + sfx;
      await w.upsert(
        "chat_read_states",
        { channel_id: channelId, user_id: uid, last_read_message_id: replyMsgId, updated_at: SEED_TS },
        "replace",
        ["channel_id", "user_id"],
      );
    }

    // 6c. enriched channel set (全体 / チーム別 / 役割別) so the chat sidebar renders a
    //     full Slack-style workspace. Names stay romaji for consistency; Japanese topics
    //     describe each. Team channels mirror member-service's real 運営チーム (see the
    //     memberTeams list in step 8 below) — no invented teams. All public/topic; every
    //     seeded user joins so channels are visible. (general above stays the event channel.)
    const extraChannels: { key: string; name: string; topic: string }[] = [
      // 全体
      { key: "announcements", name: "announcements", topic: "運営からのお知らせ・全体周知（重要連絡）" },
      { key: "random", name: "random", topic: "雑談なんでも" },
      // チーム別（member-service の運営チームに対応）
      { key: "team_soukatsu", name: "team-soukatsu", topic: "統括チーム — 全体意思決定・進行統制・チーム間調整" },
      { key: "team_dev", name: "team-dev", topic: "開発チーム — 運営ツール内製・名簿・当日連絡基盤" },
      { key: "team_ops", name: "team-ops", topic: "当日進行チーム — 進行管理・タイムテーブル・人員配置" },
      { key: "team_sponsor", name: "team-sponsor", topic: "スポンサーチーム — 協賛打診・メニュー設計・契約" },
      { key: "team_venue", name: "team-venue", topic: "会場チーム — 会場・設営・ネットワーク／配信" },
      { key: "team_pr", name: "team-pr", topic: "集客広報チーム — LP・SNS・デザイン・広報／集客" },
      // 役割/目的別
      { key: "admin", name: "admin", topic: "管理者運用・権限管理・全体統制" },
      { key: "maintainers", name: "maintainers", topic: "メンテナ調整・リリース判断・レビュー割当" },
      { key: "dev", name: "dev", topic: "開発・デプロイ・コードレビュー" },
      { key: "design", name: "design", topic: "UI/UX・デザインレビュー" },
      { key: "pr_koho", name: "pr-koho", topic: "広報・集客・SNS 運用（目的別）" },
      { key: "help", name: "help", topic: "質問・困りごと・サポート" },
    ];
    for (const c of extraChannels) {
      const cid = `chan_${c.key}${sfx}`;
      await w.upsert(
        "chat_channels",
        { id: cid, type: "topic", visibility: "public", name: c.name, topic: c.topic, event_id: null, dm_key: null, created_by: adminId, archived_at: null, version: 1, created_at: SEED_TS, updated_at: SEED_TS },
        "replace",
        ["id"],
      );
      for (const key of userKeys) {
        const uid = SEED.users[key].id + sfx;
        await w.upsert(
          "chat_channel_members",
          { channel_id: cid, user_id: uid, role: key === "admin" ? "admin" : "member", joined_at: SEED_TS },
          "replace",
          ["channel_id", "user_id"],
        );
      }
    }

    // 7. audit sample logs (INSERT OR IGNORE; backdated so cleanup may delete them).
    const auditSpecs = [
      { action: "identity.role.assigned", result: "success", rt: "user", rid: SEED.users.member.id + sfx },
      { action: "event.event.created", result: "success", rt: "event", rid: eventId },
      { action: "deploy.deployment.created", result: "success", rt: "deployment", rid: "dep_seed_1" },
      { action: "deploy.deployment.created", result: "failure", rt: "deployment", rid: "dep_seed_2" },
      { action: "identity.role.revoked", result: "denied", rt: "user", rid: SEED.users.organizer.id + sfx },
    ];
    for (let i = 0; i < auditSpecs.length; i++) {
      const a = auditSpecs[i]!;
      await w.upsert(
        "audit_logs",
        { id: `audit_seed_${i}${sfx}`, action: a.action, actor_id: adminId, org_id: SEED.orgs.primary.id, result: a.result, resource_type: a.rt, resource_id: a.rid, request_id: `req_seed_audit_${i}`, occurred_at: SEED_AUDIT_TS, recorded_at: nowIso(), details_json: "{}" },
        "ignore",
        ["id"],
      );
    }

    // 8. 運営メンバー管理 (member-service): teams + people across all statuses, so the
    //    運営メンバー screen (一覧 / チーム別 / 組織図) renders with representative data.
    // PDF「全体組織体制図」に寄せた構成: 統括チーム＋色付き5チーム、役割段は role_title で表現。
    const memberTeams = [
      { id: `member_team_hq${sfx}`, key: `soukatsu${sfx}`, name: "統括チーム", color: "#1e3a5f", description: "全体意思決定・進行統制・チーム間調整" },
      { id: `member_team_dev${sfx}`, key: `dev${sfx}`, name: "開発チーム", color: "#0d9488", description: "運営ツール内製・名簿・当日連絡基盤" },
      { id: `member_team_ops${sfx}`, key: `ops${sfx}`, name: "当日進行チーム", color: "#2563eb", description: "進行管理・タイムテーブル・人員配置" },
      { id: `member_team_sponsor${sfx}`, key: `sponsor${sfx}`, name: "スポンサーチーム", color: "#ea580c", description: "協賛打診・メニュー設計・契約" },
      { id: `member_team_venue${sfx}`, key: `venue${sfx}`, name: "会場チーム", color: "#16a34a", description: "会場・設営・ネットワーク／配信" },
      { id: `member_team_pr${sfx}`, key: `pr${sfx}`, name: "集客広報チーム", color: "#db2777", description: "LP・SNS・デザイン・広報／集客" },
    ];
    for (let i = 0; i < memberTeams.length; i++) {
      const t = memberTeams[i]!;
      await w.upsert(
        "member_teams",
        { id: t.id, org_id: SEED.orgs.primary.id, key: t.key, name: t.name, color: t.color, description: t.description, sort_order: (i + 1) * 1024, created_at: SEED_TS, updated_at: SEED_TS },
        "replace",
        ["id"],
      );
    }
    const memberPeople = [
      { id: `member_p1${sfx}`, name: "高岡 己太朗", role: "実行委員長", status: "added", teams: [0], contact: "kota@developershub.jp" },
      { id: `member_p2${sfx}`, name: "黒川", role: "統括メンバー", status: "added", teams: [0], contact: null },
      { id: `member_p3${sfx}`, name: "荒木", role: "オーガナイザー", status: "added", teams: [1], contact: null },
      { id: `member_p4${sfx}`, name: "阿閉", role: "リーダー", status: "added", teams: [1], contact: null },
      { id: `member_p5${sfx}`, name: "久米", role: "オーガナイザー", status: "added", teams: [2], contact: null },
      { id: `member_p6${sfx}`, name: "吉岡", role: "オーガナイザー", status: "added", teams: [3], contact: null },
      { id: `member_p7${sfx}`, name: "松島", role: "メンバー", status: "invited", teams: [3], contact: null },
      { id: `member_p8${sfx}`, name: "清水", role: "オーガナイザー", status: "added", teams: [4], contact: null },
      { id: `member_p9${sfx}`, name: "白木", role: "オーガナイザー", status: "added", teams: [5], contact: null },
      { id: `member_p10${sfx}`, name: "鈴木 一郎", role: "広報担当", status: "invited", teams: [5], contact: "ichiro@example.com" },
      { id: `member_p11${sfx}`, name: "山田 三郎", role: "デザイン", status: "declined", teams: [] as number[], contact: null },
    ];
    for (let i = 0; i < memberPeople.length; i++) {
      const p = memberPeople[i]!;
      await w.upsert(
        "member_people",
        { id: p.id, org_id: SEED.orgs.primary.id, name: p.name, role_title: p.role, status: p.status, contact: p.contact, note: null, sort_order: (i + 1) * 1024, version: 1, archived_at: null, created_by: adminId, created_at: SEED_TS, updated_at: SEED_TS },
        "replace",
        ["id"],
      );
      for (const teamIdx of p.teams) {
        await w.upsert(
          "member_team_links",
          { person_id: p.id, team_id: memberTeams[teamIdx]!.id, created_at: SEED_TS, updated_at: SEED_TS },
          "replace",
          ["person_id", "team_id"],
        );
      }
    }
  }

  // seed_runs ledger (idempotent: UNIQUE(dataset, run_id, fixture_hash)).
  await w.upsert(
    "seed_runs",
    { id: `seedrun_${runId}`, dataset: name, run_id: runId, fixture_hash: fixtureHash(), applied_at: nowIso() },
    "ignore",
    ["id"],
  );

  return {
    runId,
    scenario: name,
    inserted: w.inserted,
    cleanup: () => w.cleanup(),
  };
}
