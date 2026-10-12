// ガント (gantt-service). Not separate data: the chart is computed from task-service on
// every read, and the only write that changes shared data (PATCH /gantt/rows/:taskId)
// re-PATCHes the task's startAt/dueAt in task-service. So edits go through the task area
// (tasks.update) and the gantt area is read-only.
import type { AreaSpec } from "../catalog-types.ts";
import { read } from "./helpers.ts";

const S = "gantt-service";
const VIEW = { keys: ["event:read"], appLevel: { app: "gantt", level: "view" } } as const;

export const GANTT: AreaSpec = {
  area: "gantt",
  entries: [
    read({
      id: "gantt.get",
      area: "gantt",
      path: "/gantt",
      service: S,
      requires: VIEW,
      description: "イベントのガントチャート（タスクの期間と進捗）を取得する",
      hint: "query.eventId 必須。rows[].taskId・title・startsAt・endsAt・progressPercent・assigneeId、criticalTaskIds",
      query: ["eventId"],
    }),
    read({
      id: "gantt.dependencies",
      area: "gantt",
      path: "/gantt/dependencies",
      service: S,
      requires: VIEW,
      description: "ガントチャートの依存線を取得する",
      hint: "query.eventId 必須。dependencies[].fromTaskId・toTaskId",
      query: ["eventId"],
    }),
  ],
  excluded: [
    { service: S, route: "GET /gantt/views", reason: "ボット自身の表示設定（ズーム・折りたたみ）で、Dub のデータではない" },
    { service: S, route: "PUT /gantt/views", reason: "ボット自身の表示設定（ズーム・折りたたみ）で、Dub のデータではない" },
    { service: S, route: "GET /gantt/ws-ticket", reason: "リアルタイム接続用の券でデータではない" },
    { service: S, route: "PATCH /gantt/rows/:taskId", reason: "タスクの開始・期限の別経路。タスク領域の更新（tasks.update）と同じデータを書くので重複させない" },
  ],
  pending: [],
};
