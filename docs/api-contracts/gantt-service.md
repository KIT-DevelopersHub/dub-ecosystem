# gantt-service — JSON API 契約

> Read-only Gantt 合成レイヤ。task-service（タスク＋依存）と event-service（イベント存在）から
> `GanttChartDTO` を合成し、event 単位で 60s キャッシュする。加えて **ユーザー本人の行のみ**
> のビュー状態（zoom / 折りたたみ）を保存する。イベントキューを購読しキャッシュを purge する。
> gantt-service は何も publish せず、業務データを自前で持たない（純粋な transform + view-state 層）。

- 土台: [`_conventions.md`](./_conventions.md)（共通ヘッダ・エラー形・ページング・ID 規約）と
  [`auth.md`](./auth.md)（認証・認可モデル）に整合。本書はそれらに **上書きせず追従** する。
- 実装: `services/gantt-service/src/`（`app.ts` がルート、`dto.ts` が合成、`views.ts` が view-state）。
- 契約型の単一真実: `@dub/types` の `gantt` 名前空間（`packages/types/src/gantt.ts`）。

---

## 1. ベースパスとルーティング

| レイヤ | プレフィックス | 例 |
|---|---|---|
| 外部（gateway 経由・FE/MO が叩く） | `/api/v1/gantt` | `GET /api/v1/gantt?eventId=...` |
| 内部（本サービスが mount する strip 後パス） | `/gantt` | `GET /gantt?eventId=...` |

- api-gateway は `segment: "gantt"` → `SVC_GANTT` に proxy（`auth: "required"`）。strip 規約は
  「`/api/v1` のみ除去」で固定。本書のパスは以後すべて **外部パス** で記す。
- gantt に internal-only サブパスは無い（全ルートが外部公開）。
- ヘルスチェック `GET /health`（gateway を通さない運用系。`{ "status": "ok", "service": "gantt-service" }`）。

## 2. 認証・認可（全業務ルート共通）

- **認証**: `auth: required`。gateway がセッションを検証し、信頼済みヘッダ `x-dub-user-id`
  （`@dub/observability` 定数 `HDR_USER_ID`）を下流へ伝播する。本サービスは `mode: "trustedHeader"`
  でこれを読む。未認証は **401 `UNAUTHENTICATED`**。
- **認可**: 全業務ルートで `event:read` を **イベントスコープ**（`resourceType: "event"`,
  `resourceId: <eventId>`）で要求する。identity-roster の `/authz/check` に委譲（fail-closed・TTL
  キャッシュ）。権限不足は **403 `FORBIDDEN`**。
  - `event:read` は「View events/actions（gantt view はこれを再利用）」であり、gantt 専用権限は無い。
  - view-state の書き込み（`PUT /gantt/views`）も同じ `event:read` で足りる（本人の個人設定であり、
    イベントを read できる者は自分のビューを保存してよい、という設計）。
- **本人行の強制**: view-state の `userId` は **常に `x-dub-user-id` 由来**でリクエストボディからは
  一切採らない。ボディに userId を入れても無視される（他人の行は読めない・書けない）。
- 相関 ID `x-dub-request-id`（`HDR_REQUEST_ID`）は gateway/MO3 が mint し全応答・エラーに伝播。

## 3. 共通のエラー形

すべてのエラーは `@dub/errors` の `ErrorResponse`（wire 形）で返る。

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "eventId is required",
    "details": [{ "field": "eventId", "reason": "required" }],
    "requestId": "req_01J...",
    "service": "gantt-service",
    "retryable": false
  }
}
```

- `code`: 共通コード（SCREAMING_SNAKE）＋サービス固有 `GANTT_*`。`retryable` は 5xx/一部で true。
- 全ルート横断で起こりうる共通エラー:

| status | code | 契機 |
|---|---|---|
| 400 | `VALIDATION_FAILED` | `eventId` クエリ欠落 / body 不正（`details[].field/reason`） |
| 401 | `UNAUTHENTICATED` | セッション無効・`x-dub-user-id` 欠落 |
| 403 | `FORBIDDEN` | 当該 event に対する `event:read` 権限なし |
| 404 | `GANTT_EVENT_NOT_FOUND` | event-service に当該 event が存在しない（`/gantt` のみ・§4.1 参照） |
| 502 | `UPSTREAM_UNAVAILABLE` | task/event/identity 上流が異常応答 |
| 504 | `UPSTREAM_TIMEOUT` | 上流タイムアウト |

## 4. エンドポイント

### 4.1 `GET /api/v1/gantt` — フルチャート DTO

イベントの全（非アーカイブ）タスクを行に、依存を線に合成した `GanttChartDTO` を返す。

- **クエリ**: `eventId` (必須, `EventId`)。
- **キャッシュ**: KV `gantt:dto:<eventId>`（TTL 60s）。ヒット時は合成せず即返す。
  リクエストヘッダ `Cache-Control: no-cache` でキャッシュを迂回して再合成できる（結果は put し直す）。
- **存在チェック**: 合成前に event-service で存在確認。無ければ **404 `GANTT_EVENT_NOT_FOUND`**。
- **合成規則**（`dto.ts`・P0 固定）:
  - `archivedAt !== null` のタスクは行から除外。
  - `startsAt` は常に `null`（Task に start が無い）。`endsAt = dueAt`。
  - `progressPercent`: `status === "done"` → `100`、それ以外 → `0`（P0 は部分進捗なし）。
  - 依存線 `id = "${taskId}->${dependsOnId}"`、`fromTaskId = 先行(dependsOnId)`、
    `toTaskId = 後続(taskId)`、`type = "FS"`（固定）、`lagDays = 0`（固定）。
  - 両端が生存行に無い線は **落とす**（dangling edge なし）。合成キー重複は dedup。

**Request**

```http
GET /api/v1/gantt?eventId=evt_01J8Z3Q7 HTTP/1.1
Authorization: Bearer <session>
```

**200 Response** (`gantt.GanttChartDTO`)

```json
{
  "eventId": "evt_01J8Z3Q7",
  "rows": [
    {
      "taskId": "tsk_01J8ZA1",
      "title": "会場を予約する",
      "startsAt": null,
      "endsAt": "2026-08-20T09:00:00Z",
      "progressPercent": 100,
      "assigneeId": "usr_01J8ZB2"
    },
    {
      "taskId": "tsk_01J8ZA2",
      "title": "登壇者に連絡する",
      "startsAt": null,
      "endsAt": "2026-08-18T09:00:00Z",
      "progressPercent": 0,
      "assigneeId": null
    }
  ],
  "dependencies": [
    {
      "id": "tsk_01J8ZA2->tsk_01J8ZA1",
      "fromTaskId": "tsk_01J8ZA1",
      "toTaskId": "tsk_01J8ZA2",
      "type": "FS",
      "lagDays": 0
    }
  ]
}
```

**エラー**: §3 の共通表（400 / 401 / 403 / **404 `GANTT_EVENT_NOT_FOUND`** / 502 / 504）。

---

### 4.2 `GET /api/v1/gantt/dependencies` — 依存線のみ（軽量再取得）

依存線だけを再取得する軽量版（線の再描画用）。存在チェックとキャッシュは行わない。

- **クエリ**: `eventId` (必須, `EventId`)。
- 応答は §4.1 と同じ合成規則（dangling drop / dedup）を通した `dependencies` のみ。

**200 Response**

```json
{
  "eventId": "evt_01J8Z3Q7",
  "dependencies": [
    {
      "id": "tsk_01J8ZA2->tsk_01J8ZA1",
      "fromTaskId": "tsk_01J8ZA1",
      "toTaskId": "tsk_01J8ZA2",
      "type": "FS",
      "lagDays": 0
    }
  ]
}
```

**エラー**: 400 / 401 / 403 / 502 / 504（このルートは 404 を返さない）。

---

### 4.3 `GET /api/v1/gantt/views` — 本人のビュー状態を取得

呼び出しユーザー（`x-dub-user-id`）× event のビュー状態を返す。未保存なら既定値を返す（404 にしない）。

- **クエリ**: `eventId` (必須, `EventId`)。
- **既定値**: `{ eventId, zoom: "week", collapsedTaskIds: [] }`。
- 永続化は LWW（バージョン無し・単一ユーザーの個人設定なので並行制御なし）。

**200 Response** (`gantt.GanttViewState`)

```json
{
  "eventId": "evt_01J8Z3Q7",
  "zoom": "week",
  "collapsedTaskIds": ["tsk_01J8ZA1"]
}
```

**エラー**: 400 / 401 / 403 / 502 / 504。

---

### 4.4 `PUT /api/v1/gantt/views` — 本人のビュー状態を保存（upsert）

呼び出しユーザー × event のビュー状態を upsert する。保存後の正規化済み状態を返す。

- **クエリ**: `eventId` (必須, `EventId`)。
- **Request body** (`gantt.PutGanttViewRequest`):

| フィールド | 型 | 必須 | 制約 |
|---|---|---|---|
| `zoom` | `"day" \| "week" \| "month"` | ✓ | 列挙外は 400 `VALIDATION_FAILED`（`field: "zoom", reason: "invalid_enum"`） |
| `collapsedTaskIds` | `string[]` (`TaskId[]`) | ✓ | 非配列 / 非文字列要素は 400（`field: "collapsedTaskIds", reason: "invalid_type"`） |

- ボディ内の `userId` / `eventId` は無視（userId は信頼ヘッダ、eventId はクエリが正）。

**Request**

```http
PUT /api/v1/gantt/views?eventId=evt_01J8Z3Q7 HTTP/1.1
Authorization: Bearer <session>
Content-Type: application/json

{ "zoom": "day", "collapsedTaskIds": ["tsk_01J8ZA1", "tsk_01J8ZA2"] }
```

**200 Response** (`gantt.GanttViewState`)

```json
{
  "eventId": "evt_01J8Z3Q7",
  "zoom": "day",
  "collapsedTaskIds": ["tsk_01J8ZA1", "tsk_01J8ZA2"]
}
```

**エラー**: 400（body/zoom/collapsedTaskIds 不正）/ 401 / 403 / 502 / 504。

---

## 5. キャッシュ無効化（購読イベント・非 HTTP）

HTTP 契約ではないが FE/上流の理解のため明記。gantt は queue `dub-q-evt-gantt`（DLQ
`dub-q-evt-gantt-dlq`）を購読し、対象 event の DTO キャッシュを purge する。処理は全て冪等（purge/DELETE）。

| イベント | 動作 |
|---|---|
| `task.created` / `task.updated` / `task.assigned` / `task.status_changed` / `task.archived` / `task.dependency_changed` | 当該 `eventId` の DTO キャッシュを purge |
| `action.created` / `action.updated` / `action.status_changed` / `action.archived` | 同上 |
| `event.updated` / `event.phase_changed` | 同上 |
| `event.archived` | DTO キャッシュ purge **＋** 当該 event の全 view-state 行を削除（§4 cascade） |

未知イベントは `ack`（握り潰さず正常確認）。

## 6. データ型リファレンス（`@dub/types` gantt）

```ts
type GanttZoom = "day" | "week" | "month";

interface GanttRow {
  taskId: TaskId;
  title: string;
  startsAt: ISODateTime | null;   // P0: 常に null
  endsAt: ISODateTime | null;     // = task.dueAt
  progressPercent: number;        // 0-100（P0: done=100 / else=0）
  assigneeId: UserId | null;
}

interface GanttDependencyLine {
  id: string;                     // `${taskId}->${dependsOnId}`
  fromTaskId: TaskId;             // 先行(predecessor)
  toTaskId: TaskId;               // 後続(successor)
  type: "FS";                     // P0 固定
  lagDays: number;                // P0 固定 0
}

interface GanttChartDTO {
  eventId: EventId;
  rows: GanttRow[];
  dependencies: GanttDependencyLine[];
}

interface GanttViewState {
  eventId: EventId;
  zoom: GanttZoom;
  collapsedTaskIds: TaskId[];
}

interface PutGanttViewRequest {   // PUT /gantt/views の body
  zoom: GanttZoom;
  collapsedTaskIds: TaskId[];
}
```

## 7. 早見表

| メソッド | 外部パス | 認可 | 主な応答型 | 特有エラー |
|---|---|---|---|---|
| GET | `/api/v1/gantt?eventId=` | `event:read`(event) | `GanttChartDTO` | 404 `GANTT_EVENT_NOT_FOUND` |
| GET | `/api/v1/gantt/dependencies?eventId=` | `event:read`(event) | `{ eventId, dependencies[] }` | — |
| GET | `/api/v1/gantt/views?eventId=` | `event:read`(event) | `GanttViewState` | — |
| PUT | `/api/v1/gantt/views?eventId=` | `event:read`(event) | `GanttViewState` | 400 zoom/collapsedTaskIds |
| GET | `/health` | なし（運用系） | `{ status, service }` | — |
