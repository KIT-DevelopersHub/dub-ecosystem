// カレンダー > ミーティング (drive-share-service /meetings): meetings created on the shared Google
// account (Drive共有 > 設定) with a Meet link, inviting the target role's members. Every write
// goes to Google Calendar live and Google mails the attendees (invite / update / cancellation).
import type { AreaSpec } from "../catalog-types.ts";
import { read } from "./helpers.ts";

const SHARE = "drive-share-service";
const VIEW = { keys: ["calendar:meetings_view"], appLevel: { app: "calendar", level: "view" } } as const;
const EDIT = { keys: ["calendar:meetings_edit"], appLevel: { app: "calendar", level: "edit" } } as const;
const MAIL_NOTE = "Google から参加者に招待・変更・取消のメールが届き、送ったメールは取り消せません。";

export const MEETING: AreaSpec = {
  area: "meeting",
  entries: [
    read({
      id: "meetings.list",
      area: "meeting",
      path: "/meetings",
      service: SHARE,
      requires: VIEW,
      description: "共有 Google アカウントのミーティング一覧を取得する",
      hint: "items[].id・title・targetId・targetName・startsAt(UTC)・durationMinutes・recurrence・until・meetUrl・attendeeCount。account.calendarReady=false なら書き込みは409（Drive共有 > 設定 で再接続が必要）",
    }),
    read({
      id: "meetings.targets",
      area: "meeting",
      path: "/meetings/targets",
      service: SHARE,
      requires: VIEW,
      description: "ミーティングの対象（ロールと全体）を取得する",
      hint: "items[].id（ロール id、全体は \"all\"）・name・memberCount。meetings.create の targetId はここから選ぶ",
    }),
    {
      id: "meetings.create",
      area: "meeting",
      method: "POST",
      path: "/meetings",
      service: SHARE,
      requires: EDIT,
      kind: "write",
      reversible: false,
      risk: "high",
      description: "Meet 付きのミーティングを作り、対象ロールのメンバーを招待する",
      hint: "body.title(1-200)・targetId（meetings.targets の id）・startsAt（ISO。日本時間なら +09:00 を付ける）・durationMinutes(5-720)・recurrence(none|weekly|biweekly|monthly_weekday)・until（YYYY-MM-DD、任意）・description（任意）。monthly_weekday は初回の「第N X曜日」で繰り返す（第5週は最終週）。応答は作成した Meeting（id・meetUrl）",
      impact: `{count}件のミーティングが共有 Google アカウントのカレンダーに作られ、対象ロールのメンバー全員が招待されます。${MAIL_NOTE}ミーティングは削除できます。`,
      body: {
        allowed: ["title", "description", "targetId", "startsAt", "durationMinutes", "recurrence", "until"],
        required: ["title", "targetId", "startsAt", "durationMinutes", "recurrence"],
      },
      fieldLabels: {
        title: "タイトル",
        description: "説明",
        targetId: "対象",
        startsAt: "開始日時",
        durationMinutes: "所要時間（分）",
        recurrence: "繰り返し",
        until: "繰り返しの終了日",
      },
      verify: {
        read: "meetings.list",
        findIn: "items",
        findBy: ["id", "$result.id"],
        expect: { title: "$body.title", targetId: "$body.targetId", durationMinutes: "$body.durationMinutes", recurrence: "$body.recurrence" },
      },
    },
    {
      id: "meetings.update",
      area: "meeting",
      method: "PATCH",
      path: "/meetings/:id",
      service: SHARE,
      requires: EDIT,
      kind: "write",
      reversible: true,
      risk: "high",
      description: "ミーティングの内容（タイトル・日時・繰り返し・対象）を変更する",
      hint: "params.id は meetings.list の items[].id。body は変えたい項目だけ（meetings.create と同じ項目）。targetId を変えると別のカレンダーに作り直し、Meet の URL も変わる",
      impact: `{count}件のミーティングの内容が変わります。${MAIL_NOTE}もう一度変更すれば内容は戻せます。`,
      body: { allowed: ["title", "description", "targetId", "startsAt", "durationMinutes", "recurrence", "until"], required: [] },
      fieldLabels: {
        title: "タイトル",
        description: "説明",
        targetId: "対象",
        startsAt: "開始日時",
        durationMinutes: "所要時間（分）",
        recurrence: "繰り返し",
        until: "繰り返しの終了日",
      },
      verify: {
        read: "meetings.list",
        findIn: "items",
        findBy: ["id", "$params.id"],
        expect: { title: "$body.title", targetId: "$body.targetId", durationMinutes: "$body.durationMinutes", recurrence: "$body.recurrence" },
      },
    },
    {
      id: "meetings.delete",
      area: "meeting",
      method: "DELETE",
      path: "/meetings/:id",
      service: SHARE,
      requires: EDIT,
      kind: "delete",
      reversible: false,
      risk: "high",
      description: "ミーティングを削除する（Google カレンダーの予定も消える）",
      hint: "params.id は meetings.list の items[].id。繰り返しの予定は全回まとめて消える",
      impact: `{count}件のミーティングが Google カレンダーから消え、参加者に取消のメールが届きます。作り直すと Meet の URL は変わります。`,
      verify: {
        read: "meetings.list",
        findIn: "items",
        findBy: ["id", "$params.id"],
        present: false,
      },
    },
    {
      id: "meetings.sync",
      area: "meeting",
      method: "POST",
      path: "/meetings/sync",
      service: SHARE,
      requires: EDIT,
      kind: "write",
      reversible: false,
      risk: "high",
      description: "ミーティングの招待を今のロールの所属メンバーに合わせ直す",
      hint: "新しく所属した人を招待し、抜けた人からは Dub が付けた招待だけを外す（手で追加したゲストは残る）。1時間ごとに自動でも走る。応答 invitedAdded・invitedRemoved・withoutGoogleAccount[]（名簿に Gmail が無く Dub のアドレスで招待した人）",
      impact: `{count}回の同期で、新しく所属した人が招待され、抜けた人は招待から外れます。${MAIL_NOTE}`,
      unverifiable: "同期は招待の差分を合わせる操作で、結果は応答の件数でしか分からない（一覧には同期の状態が出ない）",
    },
  ],
  excluded: [],
  pending: [],
  ownerOpenedIrreversible: {
    "meetings.create": "作成は削除で取り消せるが、参加者への招待メールは取り消せない。オーナーが「ミーティングを1件ずつ追加する」ために名指しで開放",
    "meetings.delete": "削除すると同じ Meet の URL は戻らず、参加者に取消メールが届く。オーナーが「ミーティングの削除」を名指しで開放",
    "meetings.sync": "招待の追加・解除は再同期で合わせ直せるが、招待・取消のメールは取り消せない。オーナーが「招待の同期」を名指しで開放",
  },
};
