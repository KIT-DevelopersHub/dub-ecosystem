# 送る・受け取る — 極小 PR ロードマップ

Status: Roadmap (v1). [設計正本](./send-receive-task-requests.md) を、レビュー可能な**極小増分**（1 PR = 1つの小さな責務）に割る。
原則: **契約（SoT）→ バックエンド → フロント**、**バックエンド先行 → フロント**。各 PR は独立にレビュー・マージできる粒度（目安 200 行以内）。

---

## 目次

- [1. フェーズ全体像](#1-フェーズ全体像)
- [2. PR 一覧（順序・依存・触るファイル・受け入れ基準・衝突）](#2-pr-一覧順序依存触るファイル受け入れ基準衝突)
- [3. 衝突マップ（PredecessorPicker 改修との順序）](#3-衝突マップpredecessorpicker-改修との順序)
- [4. 並列可能性（波状に配る指針）](#4-並列可能性波状に配る指針)

---

## 1. フェーズ全体像

| フェーズ | 中身 | PR |
|---|---|---|
| A. 契約 (SoT) | `@dub/types` / `@dub/events` / OpenAPI に additive 追加。ランタイム挙動ゼロ | PR1〜PR3 |
| B. Feature 1 backend | 依存の同一チーム制約（門番）。スキーマ変更なし | PR4 |
| C. Feature 2/3 backend | 新テーブル＋member client＋依頼/承認/cross-link エンドポイント | PR5〜PR12 |
| D. gantt-service | cross-link を読んで crossTeamRole 射影（矢印は描かない） | PR13 |
| E. フロント | 依頼/承認 UI・チーム内限定ピッカー・ステータス文言バッジ | PR14〜PR18 |

依存の大原則: **A を全部先に landさせる**（契約が固まらないと B/E が二重定義になる）。B は A のうち PR1 のみに依存。C は PR1/PR2 に依存。E は C/D と、さらに**別エージェントの PredecessorPicker 改修**に依存（[3章](#3-衝突マップpredecessorpicker-改修との順序)）。

---

## 2. PR 一覧（順序・依存・触るファイル・受け入れ基準・衝突）

### フェーズ A — 契約 (SoT)

| PR | 責務 | 触る | 依存 | 受け入れ基準 | 衝突リスク |
|---|---|---|---|---|---|
| **PR1** | task-request / cross-link の型＋ワイヤ記述子 | `packages/types/src/task.ts`（`TaskRequest*`/`TaskCrossLink`/`TaskCrossRole`/`TASK_REQUEST_WIRE`＋compile guard）、`docs/api-contracts/task-service.md`、`docs/openapi/task-service.yaml` | — | 型が compile／wire guard green／OpenAPI に7エンドポイント記載 | 低（純追加）。`task.ts` は多数のブランチが触るので**早めに land** |
| **PR2** | 新イベント名＋payload＋購読 | `packages/events/src/catalog.ts`（`task.request.*`/`task.cross_link.created`＋`SUBSCRIPTIONS`）、`packages/events/src/payloads.ts` | — | `DubEventPayloadMap` と `SUBSCRIPTIONS` の網羅 satisfies が green | 低。catalog は frozen 慣習に沿い additive のみ |
| **PR3** | gantt 読み取りモデルの additive 装飾 | `packages/types/src/gantt.ts`（`GanttRow.crossTeamRole`/`GanttChartDTO.crossLinks`）、`docs/openapi/gantt-service.yaml` | PR1 | 型 compile／既定状態が従来と byte 互換（optional 未設定時） | 低 |

### フェーズ B — Feature 1 backend（依存の同一チーム限定・門番）

| PR | 責務 | 触る | 依存 | 受け入れ基準 | 衝突リスク |
|---|---|---|---|---|---|
| **PR4** | `PUT /tasks/:id/dependencies` に同一 `team_id` 制約 | `services/task-service/src/app.ts`（候補除外＋新 reason）、`services/task-service/src/repo.ts`（バケットの `team_id` も引くヘルパ）、`services/task-service/src/errors.ts`、`services/task-service/test/app.test.ts` | PR1（reason 定数） | 他チーム id は `400 cross_team_not_allowed`／null team 同士は依存可／同一チームは従来どおり CPM 動作／回帰テスト green | 中: `app.ts` の依存ハンドラは `fix/gantt-dep-*` 系ブランチと近い。マージ前にリモート確認 |

### フェーズ C — Feature 2/3 backend

| PR | 責務 | 触る | 依存 | 受け入れ基準 | 衝突リスク |
|---|---|---|---|---|---|
| **PR5** | マイグレーション（2テーブル）＋repo 行型・CRUD スタブ | `infra/d1/migrations/task/0006_task_requests.sql`・`0007_task_cross_links.sql`、`services/task-service/src/migrations.ts`（鏡像）、`services/task-service/src/repo.ts`（Row/insert/get）、`services/task-service/test/migrations.test.ts` | — | migration lint green／repo unit（挿入・取得・状態遷移）green／既存テーブル無変更 | 低（純追加テーブル） |
| **PR6** | member-service クライアント（user→teams 解決） | `services/task-service/src/clients.ts`（`MemberClient.teamsOfUser`）、`services/task-service/src/deps.ts`（wire）、`services/task-service/src/env.ts`（`SVC_MEMBER` binding）、`wrangler.toml`、テスト（fake） | — | `GET /members/people/by-identity/:id` を叩き teamIds を返す／404 は空配列／fake で単体 green | 中: member-service 側に `by-identity` が無ければ**先に member-service に追加 PR**が要る（下記 PR6a） |
| **PR6a**（要否確認） | member-service に `GET /members/people/by-identity/:id` | `services/member-service/*`、`docs/openapi/…`、テスト | — | identityUserId から member+teamIds を返す | member-service 担当と要調整。既存に相当 API があれば PR6a 不要 |
| **PR7** | `POST /task-requests`：自/自チーム→即タスク / 他→pending request | `services/task-service/src/app.ts`（新ルート）、`repo.ts`、`errors.ts`、`events.ts`（`task.request.created` emit）、テスト | PR1,PR2,PR5,PR6 | 自分/自チームは `{kind:"task"}`／他チームは `{kind:"request"}`＋通知イベント／権限 `task:write` | 中: `app.ts` 集中。ルート追加は局所化して衝突面を小さく |
| **PR8** | `GET /task-requests`（incoming/outgoing）＋`GET /task-requests/:id` | `app.ts`、`repo.ts`（list）、テスト | PR5 | box=incoming は to=self・outgoing は from=self／state フィルタ／cursor paging | 低 |
| **PR9** | `POST /task-requests/:id/accept`：受け手タスク＋依頼者追跡タスク＋cross-link 生成 | `app.ts`、`repo.ts`（cross-link insert・request 状態遷移）、`events.ts`（`task.request.accepted`/`task.cross_link.created`）、テスト | PR5,PR7 | 受け手のみ可（他は `403`）／pending のみ可（他は `409`）／`{request,createdTask,crossLink}`／両タスク存在 | 中: 生成順・楽観ロックの整合。トランザクション境界をテストで固定 |
| **PR10** | `POST /task-requests/:id/decline` ＋ `/cancel` | `app.ts`、`repo.ts`、`events.ts`、テスト | PR5,PR7 | decline=受け手のみ / cancel=依頼者のみ・pending のみ／状態遷移とイベント | 低 |
| **PR11** | `GET /tasks/cross-links?eventId=` ＋ `GET /tasks/:id` の additive 装飾 | `app.ts`、`repo.ts`（listCrossLinksByEvent）、`docs/api-contracts/task-service.md`、テスト | PR1,PR5 | `/tasks/dependencies` と同型で cross-link を返す／eventId 必須 | 低 |
| **PR12**（任意・D4） | `POST /tasks` の cross-team assignee 拒否ガード | `app.ts`（create 検証）、テスト | PR6 | team_id 非 null かつ assignee のチームが交差しない時のみ `422`／teamless は素通し（後方互換） | 中: 既存 create 挙動に触る。フラグ的に最後・リスク高なら保留 |

### フェーズ D — gantt-service

| PR | 責務 | 触る | 依存 | 受け入れ基準 | 衝突リスク |
|---|---|---|---|---|---|
| **PR13** | cross-link を読み `crossTeamRole` を射影（矢印は描かない）＋購読 purge | `services/gantt-service/src/upstream.ts`（listCrossLinks）、`ports.ts`、`dto.ts`（row 装飾・`crossLinks` 同梱）、`queue.ts`（`task.cross_link.created` 購読）、テスト | PR3,PR11 | cross-link 端点に role バッジ相当が付く／**`GanttDependencyLine` は増えない**（矢印ゼロ）／dangling は落とす | 中: `dto.ts` は `fix/gantt-*` 群と近い。リベース前提 |

### フェーズ E — フロント（★ PredecessorPicker 改修の後）

| PR | 責務 | 触る | 依存 | 受け入れ基準 | 衝突リスク |
|---|---|---|---|---|---|
| **PR14** | fe4 の API ラッパ（task-requests / cross-links）＋mock＋wire test | `apps/fe4-task-gantt/src/api/endpoints.ts`、`mock-client.ts`、`test/endpoints-wire-contract.test.ts` | PR1 | クエリキーは `TASK_REQUEST_WIRE` から導出（ハンドリネームしない）／mock も同じキー／wire test green | 低〜中: `endpoints.ts` は fe4 全ブランチが触る要衝。小さく |
| **PR15** ★ | **Feature 1 フロント**: `dependencyScopeOptions` に同一 team 絞り＋各ピッカーへ `teamId` 伝播 | `apps/fe4-task-gantt/src/domain/task-hierarchy.ts`、`PredecessorPicker.tsx`、`TaskCreateModal.tsx`、`TaskDetailPanel.tsx`、関連テスト | PR4 ＋ **別エージェントの PredecessorPicker 改修が land 済み** | 他チームは候補に出ない／同一チームは従来どおり／既存の兄弟スコープ絞りと両立 | **高**: `feat/fe4-parent-task-search`（PredecessorPicker/親検索改修）と同一ファイル。**その PR のマージ後にリベースして着手**（3章） |
| **PR16** | マイタスク「受け取った依頼」一覧＋承諾/却下 UI（楽観的） | `apps/fe4-task-gantt/src/**`（My Tasks 受信セクション・hooks）、`domain/my-tasks.ts`、テスト | PR8,PR9,PR14 | incoming pending を表示／承諾で自分の担当に出る／楽観反映＋失敗ロールバック／スケルトン | 中: `fix/mytasks-issue-button*` 系と近い。My Tasks 周辺を確認 |
| **PR17** | 依頼発行 UI 拡張（自分→他人・自/他チームのヒント表示） | `apps/fe4-task-gantt/src/**`（`MyTaskCreateModal` 拡張）、`useTeams` 併用、テスト | PR7,PR14 | 宛先選択で他チームなら「承認が必要」ヒント／送信は `POST /task-requests`／楽観反映 | 中: `MyTaskCreateModal` は mytasks 系ブランチと重なる |
| **PR18** | クロスチーム状態バッジ（「タスクをお願いした/受け負った」）を両ビューに | `packages/app-ui`（共有 `CrossTeamRoleBadge`）、`apps/fe4-task-gantt`（マイタスク行・ガント行に差し込み）、テスト | PR3,PR13,PR14 | role から文言を生成（保存文言に依存しない）／マイタスク・ガント両方に同期表示／トークン準拠・デザイナーレビュー | 中: ガント行レンダは `fix/gantt-*` と近い |

---

## 3. 衝突マップ（PredecessorPicker 改修との順序）

現在リポジトリに走行中の関連ブランチ（`git worktree list` で観測）:

- `feat/fe4-parent-task-search`（親タスク検索/PredecessorPicker 周辺の改修）← **PR15 と同一ファイル群**
- `fix/mytasks-issue-button` / `fix/mytasks-issue-button-no-events`（マイタスク発行ボタン）← **PR16/PR17 と近接**
- `fix/gantt-dep-*` / `fix/gantt-*`（gantt 依存・描画）← **PR4/PR13 と近接**

**順序ルール**:

1. **PR15（Feature1 フロント）は、`feat/fe4-parent-task-search` が main にマージされてから着手**。着手時に最新 main へリベースし、`task-hierarchy.ts` の `dependencyScopeOptions` シグネチャが改修後どうなったかを確認してから team 絞りを足す（改修で siblings ロジックが変わっている可能性）。
2. **PR4（Feature1 バックエンド門番）は独立に先行可**。フロントの改修状況に依存しない（サーバ側の検証追加だけ）。**先に PR4 を出しておけば、フロントが遅れても API は安全**。
3. **PR16/PR17 は `fix/mytasks-issue-button*` の後**。My Tasks 周辺の最新形にリベースしてからセクション追加。
4. **PR13 は `fix/gantt-*` の後**。`dto.ts` の最新にリベース。

**衝突を最小化する書き方**: 新エンドポイント/新セクションは**既存関数を書き換えず追記**で入れる（ルート追加・新コンポーネント差し込み）。既存ハンドラ本体（`app.ts` の dependencies ハンドラ、`dto.ts` の row 構築）に触るのは PR4/PR13/PR15 のみで、そこはリベース前提。

---

## 4. 並列可能性（波状に配る指針）

- **第1波（すぐ並列可・依存少）**: PR1・PR2・PR5（契約とスキーマは互いに独立）。PR1 は最優先で land（`task.ts` の衝突面を早く閉じる）。
- **第2波**: PR3（←PR1）、PR4（←PR1）、PR6/PR6a（member client・要否確認）。
- **第3波**: PR7（←PR1,2,5,6）→ PR8/PR9/PR10/PR11（←PR5,7）。PR7 が要。PR8〜11 は PR7 後にほぼ並列。
- **第4波**: PR13（←PR3,11）、PR14（←PR1）。
- **第5波（フロント本体・要リベース）**: PR15（★別エージェント後）、PR16、PR17、PR18。UI 変更は必ずデザイナー視点レビュー＋実ブラウザ E2E を別工程で。

各波内は worktree 隔離で並列実行。触るファイルが重なる PR（PR7〜PR11 は全部 `app.ts`）は**直列 or こまめなリベース**にする（同一ファイル同時 checkout を避ける）。
