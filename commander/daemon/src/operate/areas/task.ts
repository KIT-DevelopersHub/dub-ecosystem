// タスク (task-service).
import type { AreaSpec } from "../catalog-types.ts";
import { read } from "./helpers.ts";

const S = "task-service";
const VIEW = { keys: ["task:read"], appLevel: { app: "tasks", level: "view" } } as const;

export const TASK: AreaSpec = {
  area: "task",
  entries: [
    read({
      id: "tasks.list",
      area: "task",
      path: "/tasks",
      service: S,
      requires: VIEW,
      description: "タスクの一覧を取得する",
      hint: "query.eventId が実質必須（無いと400）。items[].id・title・status・priority・assigneeId・startAt・dueAt・version",
      query: ["eventId", "assigneeId", "teamId", "createdById", "status", "limit", "cursor"],
    }),
    read({
      id: "tasks.get",
      area: "task",
      path: "/tasks/:id",
      service: S,
      requires: VIEW,
      description: "タスク1件の詳細を取得する",
      hint: "title・description・status・priority・assigneeId・teamId・parentTaskId・startAt・dueAt・version。更新前に version を読む",
    }),
    read({
      id: "tasks.dependencies.list",
      area: "task",
      path: "/tasks/dependencies",
      service: S,
      requires: VIEW,
      description: "イベント内のタスクの依存関係を取得する",
      hint: "query.eventId 必須。items[].taskId・dependsOnId",
      query: ["eventId"],
    }),
    read({
      id: "tasks.attachments.list",
      area: "task",
      path: "/tasks/:id/attachments",
      service: S,
      requires: VIEW,
      description: "タスクの添付（ファイル・リンク）一覧を取得する",
      hint: "items[].id・kind(file|url)・name・url",
    }),
  ],
  excluded: [
    { service: S, route: "DELETE /tasks/:id", reason: "アーカイブすると元に戻す API が無い（不可逆）" },
    { service: S, route: "DELETE /tasks/:id/attachments/:attachmentId", reason: "アーカイブすると元に戻す API が無い（不可逆）" },
  ],
  pending: [
    { service: S, route: "POST /tasks" },
    { service: S, route: "PATCH /tasks/:id" },
    { service: S, route: "PUT /tasks/:id/dependencies" },
    { service: S, route: "POST /tasks/:id/attachments" },
  ],
};
