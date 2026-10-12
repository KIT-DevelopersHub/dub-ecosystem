// Commander (services/commander-service: the local phase-gate / task-board API).
// Not behind the Dub api-gateway: every entry has target "commander", so the executor calls
// the local commander-service with the operator token and no API_PREFIX. Its routes are
// gated by protection-table.ts (OPERATOR = operator token, no permission keys), which the
// catalog test reads in place of a policy-table.ts.
import type { AreaSpec, CatalogEntry } from "../catalog-types.ts";
import { read } from "./helpers.ts";

const S = "commander-service";
const OPERATOR = { keys: [] } as const;
const c = (e: Omit<CatalogEntry, "area" | "service" | "requires" | "target">): CatalogEntry => ({
  ...e,
  area: "commander",
  service: S,
  requires: OPERATOR,
  target: "commander",
});
const r = (e: Omit<CatalogEntry, "area" | "service" | "requires" | "target" | "method" | "kind" | "reversible" | "risk" | "impact">): CatalogEntry =>
  ({ ...read({ ...e, area: "commander", service: S, requires: OPERATOR }), target: "commander" });

const SELF_REFERENCE = "「Dubに聞く」「Dubを操作」の会話そのもの（この画面が自分で書く履歴）。操作から書き換えると自己参照になり、会話の記録が壊れる";

export const COMMANDER: AreaSpec = {
  area: "commander",
  entries: [
    r({
      id: "commander.tasks.list",
      path: "/tasks",
      description: "Commander ボードのタスク一覧を取得する",
      hint: "items[].taskId・featureId・title・featurePhase・taskStatus(todo|doing|done)・demoUrl・stagingUrl・prUrl・prUrls・latestRun{id,status,cwd}。タスク名から featureId/taskId を探すのはここ",
    }),
    r({
      id: "commander.features.list",
      path: "/features",
      description: "Commander の機能（フェーズ管理の単位）の一覧を取得する",
      hint: "features[].id・title・phase・ledgerRef",
    }),
    r({
      id: "commander.features.get",
      path: "/features/:id",
      description: "Commander の機能1件のフェーズと、次に進める・戻せる先と履歴を取得する",
      hint: "feature{id,title,phase}・allowedTransitions[]{to,requiresApproval,label,rewind?}・transitions[]（遷移履歴）。フェーズを変える前に必ずこれを読み、allowedTransitions にある to だけを使う",
    }),
    r({
      id: "commander.features.tasks",
      path: "/features/:id/tasks",
      description: "Commander の機能に属するタスクを取得する",
      hint: "tasks[].id・title・status・demoUrl・stagingUrl・prUrl",
    }),
    r({
      id: "commander.runs.list",
      path: "/runs",
      description: "Commander の実行（Claude の作業）の一覧を取得する",
      hint: "runs[].id・taskId・status・cwd・prompt・exitCode・createdAt。全件が新しい順で返る",
    }),
    r({
      id: "commander.runs.get",
      path: "/runs/:id",
      description: "Commander の実行1件と、その実行ログを取得する",
      hint: "run{id,taskId,status,prompt,cwd}・events[]{type,payload,at}。ログは長いので要点だけ読む",
    }),
    r({
      id: "commander.runs.events",
      path: "/runs/:id/events",
      description: "Commander の実行1件の実行ログを取得する",
      hint: "events[]{type,payload,at}",
    }),
    r({
      id: "commander.chats.list",
      path: "/chats",
      description: "「Dubに聞く」「Dubを操作」の会話の一覧を取得する",
      hint: "query.kind 必須（ask|operate。無いと400）。sessions[].id・kind・title・updatedAt",
      query: ["kind"],
    }),
    r({
      id: "commander.chats.get",
      path: "/chats/:id",
      description: "「Dubに聞く」「Dubを操作」の会話1件の中身を取得する",
      hint: "session{id,kind,title}・messages[]{role,text,status}",
    }),
    c({
      id: "commander.tasks.create",
      method: "POST",
      path: "/tasks",
      kind: "write",
      reversible: false,
      risk: "mid",
      description: "Commander ボードに新しいタスクを作る",
      hint: "機能とタスクを1件ずつ同時に作る（1タスク=1機能）。title は前後の空白なし・200字以内。応答 feature{id,phase}・task{id}。作るだけで Claude の作業（run）は始まらない",
      impact: "{count}件のタスクが Commander ボードの投入待ちに増えます（作業はまだ始まりません）。削除はできず、不要ならアーカイブ（完了）にして外します。",
      body: { allowed: ["title", "ledgerRef"], required: ["title"] },
      fieldLabels: { title: "タスク名", ledgerRef: "台帳の参照", taskStatus: "状態", featurePhase: "フェーズ" },
      verify: {
        read: "commander.tasks.list",
        findIn: "items",
        findBy: ["taskId", "$result.task.id"],
        expect: { title: "$body.title", taskStatus: "todo", featurePhase: "demo_building" },
      },
    }),
    c({
      id: "commander.tasks.updateStatus",
      method: "PATCH",
      path: "/tasks/:id",
      kind: "write",
      reversible: true,
      risk: "mid",
      description: "Commander のタスクの状態を変える（完了にするとアーカイブ）",
      hint: "params.id は taskId（commander.tasks.list の items[].taskId）。status は todo|doing|done のどれか。done = アーカイブ（完了一覧へ）。フェーズは変わらない",
      impact: "{count}件のタスクの状態が変わり、Commander ボードの表示レーンが変わります。状態を元の値に戻せば元に戻ります。",
      body: { allowed: ["status"], required: ["status"] },
      fieldLabels: { status: "状態", taskStatus: "状態" },
      verify: { read: "commander.tasks.list", findIn: "items", findBy: ["taskId", "$params.id"], expect: { taskStatus: "$body.status" } },
    }),
    c({
      id: "commander.features.transition",
      method: "POST",
      path: "/features/:id/transition",
      kind: "write",
      reversible: true,
      risk: "high",
      description: "Commander の機能のフェーズを進める・戻す（承認・却下を含む）",
      hint:
        "params.id は featureId。直前に commander.features.get で allowedTransitions を読み、そこにある to だけを指定する（無い先は段飛ばしで拒否）。" +
        "requiresApproval の辺（demo_review→staging_deployed = demo承認、staging_review→prod_shipped = staging承認）はオーナーの明示の指示がある時だけ approvedByUser:true を付ける。" +
        "却下は demo_rejected / staging_rejected、戻すのは rewind の辺。note に理由を書ける。" +
        "フェーズ表示を変えるだけで、staging/本番への反映 run は起動しない（ボードの承認ボタンとは違う）",
      impact:
        "{count}件の機能のフェーズが変わり、Commander ボードのレーンと遷移履歴に残ります。承認（staging 反映・本番反映へ進める）はオーナー本人の承認に当たるため、確認フレーズの入力が必要です。" +
        "フェーズ表示だけが変わり、staging・本番への反映作業は起動しません。戻すときは「フェーズを戻す」先へ遷移させます（履歴は消えません）。",
      body: { allowed: ["to", "approvedByUser", "note"], required: ["to"] },
      fieldLabels: { to: "遷移先のフェーズ", approvedByUser: "オーナー承認", note: "メモ", "feature.phase": "フェーズ" },
      verify: { read: "commander.features.get", params: { id: "$params.id" }, expect: { "feature.phase": "$body.to" } },
    }),
  ],
  excluded: [
    {
      service: S,
      route: "POST /features",
      reason: "タスクを持たない機能だけを作り、ボードに出ないまま削除もできない（不可逆）。タスク作成が機能とタスクを同時に作るので代わりになる",
    },
    {
      service: S,
      route: "POST /features/:id/tasks",
      reason: "既存の機能に2件目のタスクを足し「1タスク=1機能」の前提を崩す。削除もできない（不可逆）",
    },
    { service: S, route: "POST /tasks/backfill-urls", reason: "全タスクの成果物 URL を実行ログから一括で書き戻す保守用の一括操作" },
    {
      service: S,
      route: "POST /runs",
      reason: "daemon が実行記録を保存する内部経路。ここに書いても Claude は起動せず、偽の実行記録でボードのレーン判定が狂う",
    },
    { service: S, route: "POST /runs/:id/events", reason: "daemon が実行ログを書き込む内部経路。偽のログを足すとボードの成功・失敗判定と成果物 URL 抽出が狂う" },
    { service: S, route: "POST /chats", reason: SELF_REFERENCE },
    { service: S, route: "PATCH /chats/:id", reason: SELF_REFERENCE },
    { service: S, route: "DELETE /chats/:id", reason: `${SELF_REFERENCE}。さらに会話と全メッセージを物理削除する（不可逆）` },
    { service: S, route: "POST /chats/:id/messages", reason: SELF_REFERENCE },
    { service: S, route: "PATCH /chats/:id/messages/:mid", reason: SELF_REFERENCE },
  ],
  pending: [],
  ownerOpenedIrreversible: {
    "commander.tasks.create":
      "オーナーが依頼表で「タスクの作成」を名指しで開放。削除 API は無いが、状態を完了にすればアーカイブされボードから外せる",
  },
};
