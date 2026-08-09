// Local dev seed: 2 sample accounts + demo tasks so `pnpm dev` shows a populated
// board/gantt without a backend. Not used by tests (they build their own seed).
import type { task, identity } from "@dub/types";
import { MockApiClient } from "./api/mock-client";

export const DEMO_EVENT_ID = "evt_demo";

const users: identity.UserSummary[] = [
  { id: "usr_alice", displayName: "Alice 運営", avatarUrl: null },
  { id: "usr_bob", displayName: "Bob 実行委員", avatarUrl: null },
];

function mk(id: string, title: string, status: task.TaskStatus, assignee: string | null, due: string | null): task.Task {
  const now = "2026-08-01T00:00:00Z";
  return {
    id, eventId: DEMO_EVENT_ID, title, description: null, status,
    priority: "medium", assigneeId: assignee, dueAt: due, origin: "internal",
    archivedAt: null, createdAt: now, updatedAt: now, version: 1,
  };
}

export function createDevClient(): MockApiClient {
  return new MockApiClient({
    users,
    tasks: [
      mk("task_1", "会場予約", "done", "usr_alice", "2026-08-10T00:00:00Z"),
      mk("task_2", "スポンサー募集", "in_progress", "usr_bob", "2026-08-20T00:00:00Z"),
      mk("task_3", "登壇者調整", "todo", "usr_alice", "2026-08-25T00:00:00Z"),
      mk("task_4", "配信機材準備", "blocked", "usr_bob", "2026-09-01T00:00:00Z"),
    ],
    dependencies: [{ id: "task_1->task_2", fromTaskId: "task_1", toTaskId: "task_2", type: "FS", lagDays: 0 }],
    rowDates: {
      task_1: { startsAt: "2026-08-05T00:00:00Z", endsAt: "2026-08-10T00:00:00Z" },
      task_2: { startsAt: "2026-08-08T00:00:00Z", endsAt: "2026-08-20T00:00:00Z" },
      task_3: { startsAt: "2026-08-18T00:00:00Z", endsAt: "2026-08-25T00:00:00Z" },
      task_4: { startsAt: null, endsAt: null },
    },
  });
}

export const DEMO_PERMISSIONS: identity.PermissionKey[] = ["task:read", "task:write", "task:delete"];
