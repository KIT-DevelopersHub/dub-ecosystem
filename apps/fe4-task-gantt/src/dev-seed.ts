// Local dev seed: 2 sample accounts + demo tasks so `pnpm dev` shows a populated
// board/gantt without a backend. Not used by tests (they build their own seed).
// The rowDates mirror what gantt-service derives (bar = [dueAt - duration, dueAt];
// dueAt-less tasks fall onto the CPM schedule) so the standalone demo is faithful.
import type { task, identity, gantt, common, team } from "@dub/types";
import { MockApiClient } from "./api/mock-client";

export const DEMO_EVENT_ID = "evt_demo";

const users: identity.UserSummary[] = [
  { id: "usr_alice", displayName: "Alice 運営", avatarUrl: null },
  { id: "usr_bob", displayName: "Bob 実行委員", avatarUrl: null },
];

// canonical Team seed (member-service will own this list in the future).
const teams: team.Team[] = [
  { id: "team_ops", key: "ops", name: "運営", color: "#3358e8", description: "会場・当日運営" },
  { id: "team_sponsor", key: "sponsor", name: "スポンサー", color: "#f2994a", description: "協賛・渉外" },
  { id: "team_content", key: "content", name: "コンテンツ", color: "#27ae60", description: "登壇・配信" },
];

function mk(
  id: string,
  title: string,
  status: task.TaskStatus,
  priority: task.TaskPriority,
  assignee: string | null,
  due: string | null,
  teamId: common.TeamId | null = null,
): task.Task {
  const now = "2026-08-01T00:00:00Z";
  return {
    id, eventId: DEMO_EVENT_ID, title, description: null, status,
    priority, assigneeId: assignee, teamId, dueAt: due, origin: "internal",
    archivedAt: null, createdAt: now, updatedAt: now, version: 1,
  };
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
    users,
    teams,
    tasks: [
      mk("task_1", "会場予約", "done", "high", "usr_alice", "2026-08-07T00:00:00Z", "team_ops"),
      mk("task_2", "スポンサー募集", "in_progress", "high", "usr_bob", "2026-08-14T00:00:00Z", "team_sponsor"),
      mk("task_3", "登壇者調整", "in_progress", "medium", "usr_alice", "2026-08-21T00:00:00Z", "team_content"),
      mk("task_4", "配信機材準備", "todo", "medium", "usr_bob", "2026-08-28T00:00:00Z", "team_content"),
      mk("task_5", "当日運営リハ", "todo", "urgent", "usr_alice", "2026-09-03T00:00:00Z", "team_ops"),
      mk("task_6", "ノベルティ発注", "todo", "low", "usr_bob", "2026-08-24T00:00:00Z", "team_sponsor"),
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
