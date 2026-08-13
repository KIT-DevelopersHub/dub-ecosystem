// Local dev seed: 2 sample accounts + demo tasks so `pnpm dev` shows a populated
// board/gantt without a backend. Not used by tests (they build their own seed).
// The rowDates mirror what gantt-service derives (bar = [dueAt - duration, dueAt];
// dueAt-less tasks fall onto the CPM schedule) so the standalone demo is faithful.
import type { task, identity, gantt, common, team } from "@dub/types";
import { MockApiClient } from "./api/mock-client";

export const DEMO_EVENT_ID = "evt_demo";
export const DEMO_OPS_EVENT_ID = "evt_ops";
/** the signed-in user for the standalone My Tasks demo (createdBy stamp + /me scope). */
export const DEMO_CURRENT_USER = "usr_me";

const users: identity.UserSummary[] = [
  { id: "usr_me", displayName: "あなた（高岡）", avatarUrl: null },
  { id: "usr_alice", displayName: "Alice 運営", avatarUrl: null },
  { id: "usr_bob", displayName: "Bob 実行委員", avatarUrl: null },
  { id: "usr_carol", displayName: "Carol 広報", avatarUrl: null },
  { id: "usr_dave", displayName: "Dave 配信", avatarUrl: null },
  { id: "usr_erin", displayName: "Erin 渉外", avatarUrl: null },
];

/** roster for the hub's 担当者/依頼主 filter selects + create modal. */
export const DEMO_PEOPLE: identity.UserSummary[] = users;

/** event options for the create modal (task-service requires a live eventId). */
export const DEMO_EVENTS = [
  { id: DEMO_EVENT_ID, name: "北陸ITカンファレンス2026" },
  { id: DEMO_OPS_EVENT_ID, name: "運営タスク" },
];

// canonical Team seed (member-service will own this list in the future).
const teams: team.Team[] = [
  { id: "team_ops", key: "ops", name: "運営", color: "#3358e8", description: "会場・当日運営" },
  { id: "team_sponsor", key: "sponsor", name: "スポンサー", color: "#f2994a", description: "協賛・渉外" },
  { id: "team_content", key: "content", name: "コンテンツ", color: "#27ae60", description: "登壇・配信" },
];

export const DEMO_TEAMS: team.Team[] = teams;

function mk(
  id: string,
  title: string,
  status: task.TaskStatus,
  priority: task.TaskPriority,
  assignee: string | null,
  due: string | null,
  teamId: common.TeamId | null = null,
  createdBy: string = "usr_me",
): task.Task {
  const now = "2026-08-01T00:00:00Z";
  return {
    id, eventId: DEMO_EVENT_ID, title, description: null, status,
    priority, assigneeId: assignee, teamId, createdBy, dueAt: due, origin: "internal",
    archivedAt: null, createdAt: now, updatedAt: now, version: 1,
  };
}

// ---- bulk My Tasks demo data (evt_ops) ---------------------------------------
// ~140 tasks spread across the 6 people so the hub's from→to, filters, search,
// sort and windowing are all visible at a realistic (300-person-flavoured) scale.
// Due dates are spread around the demo "today" (2026-08-13) so 期限切れ/今日/今週
// buckets are meaningful. The signed-in user (usr_me) is either assignee or
// requester on a healthy slice so both lenses (担当/依頼) are populated.
const BULK_PEOPLE = ["usr_me", "usr_alice", "usr_bob", "usr_carol", "usr_dave", "usr_erin"];
const BULK_TEAMS: (common.TeamId | null)[] = ["team_ops", "team_sponsor", "team_content", null];
const BULK_STATUS: task.TaskStatus[] = ["todo", "in_progress", "blocked", "done", "in_progress", "todo"];
const BULK_PRIORITY: task.TaskPriority[] = ["low", "medium", "high", "urgent", "medium", "high"];
const BULK_TITLES = [
  "スポンサー資料の送付", "登壇者プロフィール回収", "会場レイアウト確定", "配信リハーサル調整",
  "受付フロー整理", "ノベルティ発注", "SNS告知文の作成", "アンケート設計", "名札印刷手配",
  "懇親会の会場予約", "予算表の更新", "当日スタッフ割当", "動画編集の依頼", "プレスリリース校正",
  "Wi-Fi 環境の確認", "タイムテーブル調整", "協賛社ロゴ差し替え", "領収書の整理", "看板デザイン確認",
  "参加者リスト精査",
];

const DAY = 86_400_000;
const TODAY = Date.parse("2026-08-13T00:00:00Z");

function bulkTasks(count: number): task.Task[] {
  const out: task.Task[] = [];
  for (let i = 0; i < count; i++) {
    const others = BULK_PEOPLE.filter((p) => p !== "usr_me");
    // usr_me is well represented on both sides, but never assigner AND assignee at
    // once (from→to should read as a real "誰から誰へ", not self→self).
    const assigneeId = i % 3 === 0 ? "usr_me" : BULK_PEOPLE[i % BULK_PEOPLE.length]!;
    const createdBy =
      assigneeId === "usr_me"
        ? others[i % others.length]! // assigned to me → issued by someone else
        : i % 4 === 0
          ? "usr_me" // I issued it to someone else
          : others[(i * 3 + 1) % others.length]!;
    const status = BULK_STATUS[i % BULK_STATUS.length]!;
    // due offset: mix of overdue (-), today (0), this week (+1..6), later (+7..30)
    const offsets = [-6, -3, -1, 0, 1, 2, 4, 6, 9, 14, 21, 30];
    const off = offsets[i % offsets.length]!;
    const hasDue = i % 7 !== 0; // some tasks have no due date
    const dueAt = hasDue ? new Date(TODAY + off * DAY).toISOString() : null;
    const created = new Date(TODAY - ((i % 20) + 1) * DAY).toISOString();
    out.push({
      id: `task_ops_${String(i + 1).padStart(3, "0")}`,
      eventId: DEMO_OPS_EVENT_ID,
      title: `${BULK_TITLES[i % BULK_TITLES.length]}（#${i + 1}）`,
      description: null,
      status,
      priority: BULK_PRIORITY[(i * 2 + (i % 5)) % BULK_PRIORITY.length]!,
      assigneeId,
      teamId: BULK_TEAMS[i % BULK_TEAMS.length]!,
      createdBy,
      dueAt,
      origin: "internal",
      archivedAt: null,
      createdAt: created,
      updatedAt: created,
      version: 1,
    });
  }
  return out;
}

const dep = (from: string, to: string): gantt.GanttDependencyLine => ({
  id: `${from}->${to}`, fromTaskId: from, toTaskId: to, type: "FS", lagDays: 0,
});

// bar = [dueAt - durationDays, dueAt]; medium=3d unless noted (urgent1/high2/low5).
const rd = (
  s: string | null,
  e: string | null,
): { startsAt: common.ISODateTime | null; endsAt: common.ISODateTime | null } => ({ startsAt: s, endsAt: e });

export function createDevClient(): MockApiClient {
  return new MockApiClient({
    currentUserId: DEMO_CURRENT_USER,
    users,
    teams,
    tasks: [
      mk("task_1", "会場予約", "done", "high", "usr_alice", "2026-08-07T00:00:00Z", "team_ops", "usr_me"),
      mk("task_2", "スポンサー募集", "in_progress", "high", "usr_bob", "2026-08-14T00:00:00Z", "team_sponsor", "usr_me"),
      mk("task_3", "登壇者調整", "in_progress", "medium", "usr_alice", "2026-08-21T00:00:00Z", "team_content", "usr_carol"),
      mk("task_4", "配信機材準備", "todo", "medium", "usr_bob", "2026-08-28T00:00:00Z", "team_content", "usr_me"),
      mk("task_5", "当日運営リハ", "todo", "urgent", "usr_me", "2026-09-03T00:00:00Z", "team_ops", "usr_alice"),
      mk("task_6", "ノベルティ発注", "todo", "low", "usr_bob", "2026-08-24T00:00:00Z", "team_sponsor", "usr_me"),
      ...bulkTasks(140),
    ],
    // longest chain 1->2->3->4->5 is the critical path; 6 hangs off 1 (non-critical).
    dependencies: [
      dep("task_1", "task_2"),
      dep("task_2", "task_3"),
      dep("task_3", "task_4"),
      dep("task_4", "task_5"),
      dep("task_1", "task_6"),
    ],
    rowDates: {
      task_1: rd("2026-08-05T00:00:00Z", "2026-08-07T00:00:00Z"),
      task_2: rd("2026-08-12T00:00:00Z", "2026-08-14T00:00:00Z"),
      task_3: rd("2026-08-18T00:00:00Z", "2026-08-21T00:00:00Z"),
      task_4: rd("2026-08-25T00:00:00Z", "2026-08-28T00:00:00Z"),
      task_5: rd("2026-09-02T00:00:00Z", "2026-09-03T00:00:00Z"),
      task_6: rd("2026-08-19T00:00:00Z", "2026-08-24T00:00:00Z"),
    },
    criticalTaskIds: ["task_1", "task_2", "task_3", "task_4", "task_5"],
  });
}

export const DEMO_PERMISSIONS: identity.PermissionKey[] = ["task:read", "task:write", "task:delete"];
