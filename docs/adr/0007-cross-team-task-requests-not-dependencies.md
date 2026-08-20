# ADR-0007: チーム跨ぎのタスク連携は「依存(矢印)」ではなく「依頼→承認→cross-link」で表す

- Status: Accepted
- Date: 2026-08-20
- Deciders: DevHub (Dub) core
- Related: `docs/design/send-receive-task-requests.md`, `docs/design/send-receive-roadmap.md`, task-service (#5), gantt-service, member-service
- 要確認: member-service に `by-identity` 参照が既存か（無ければ追加）。task.team_id の実在検証は本 ADR の範囲外（別課題）。

## Context

タスクは2形式で完全同期して見せている（マイタスク＝タスク管理ビュー / ガント＝工程ビュー）。
ガントの依存線（`task_dependencies`）は `@dub/gantt-calc` の CPM/クリティカルパスを駆動する「工程順序」の道具で、
現状は**同一バケット（イベント、または未リンクのバケット）内**でのみ張れる。

ここに「チームを跨いだタスク連携」を入れたい。会計チームがスポンサーチームの誰かに作業を頼む、等。
素直にやると「他チームのタスクを先行タスクに選び、矢印を引く」になるが、これは:

1. 相手の都合を無視して工程へ強制挿入できてしまう（人間の合意が無い）。
2. 他チームの工程が自チームの CPM に混ざり、クリティカルパス計算が別チーム都合で揺れる。
3. ガントが「誰も承諾していない依存」を確定線として描く。

一方で、同一チーム内の依存は今のまま矢印で扱いたい（工程管理として正しい）。

## Decision

**依存（矢印）とチーム跨ぎ連携（合意）を別レイヤに分離する。**

1. **依存は同一 `team_id` 限定**にする。`PUT /tasks/:id/dependencies` は既存の「同一バケット」条件に
   「同一 `team_id`」を AND する（`team_id=null` 同士は同一とみなす）。他チーム id は `400`
   （`cross_team_not_allowed`）。これは**両タスクの team_id 文字列比較**で成立し、新サービス呼び出しを増やさない。
2. **チーム跨ぎは依頼→承認**で扱う。新 `task_requests`（`pending/accepted/declined/cancelled`）。
   依頼発行時、サーバが依頼者と受け手の所属（member-service の teamIds）を解決し:
   - 自分 / 自チーム（所属が交差）→ **即タスク化**（承認なし・従来の作成経路）。
   - 他チーム（交差なし）→ **pending の request** を作り受け手へ通知。受け手が承諾して初めてタスク化。
3. **承認後の連携は矢印でなく `task_cross_links`** で表す（`task_dependencies` に入れない）。
   よってガントは矢印を描かず、CPM にも混ざらない。両タスクには **role から導出したステータス文言**
   （依頼側「タスクをお願いした」/ 受け手側「タスクを受け負った」）をマイタスク・ガント両方に同期表示する。
   文言は保存せず role から生成する（自動生成・常に同期をコードで担保）。

`task_cross_links` / `task_requests` は task 名前空間内の新規テーブル（同一名前空間 FK のみ・ADR-0005 準拠）。
既存テーブル・既存イベント名は不変（すべて additive）。

## Alternatives considered

| 案 | 内容 | 却下理由 |
|---|---|---|
| A. 他チームも `task_dependencies` に矢印 | 既存依存をチーム跨ぎ許可のまま | 合意なし挿入・CPM 汚染・要件（矢印を引かない）に反する |
| B. `task_dependencies` に `kind=cross_team` 列を足し UI で出し分け | 1テーブルに同居 | CPM/サイクル計算が cross を無視する分岐だらけになる。矢印描画の落とし穴。関心が混ざる |
| C. ステータス文言を DB に保存 | accept 時に両タスクへ文言カラム | 二重管理・同期ズレの温床。role から導出すれば1箇所 |
| D. 自チーム依頼にも承認を挟む | 一律承認フロー | 同チームは合意コストが低く摩擦が無駄。要件は「自然に追加・同期」 |

採用は **依存=同一チーム限定 + チーム跨ぎ=request/approval + 非依存 cross-link + 文言は導出**。

## Consequences

- **良い**: ガントの CPM は自チーム工程だけで閉じ、計算が安定。チーム跨ぎは人間の承諾を必ず経る。
  文言が導出なので常に整合。すべて additive で既存を壊さない。契約→バックエンド→フロントの極小 PR で段階投入できる。
- **コスト**: task-service に member-service クライアント（user→teams 解決）を新設する依存が増える
  （Feature 2 のみ・Feature 1 は不要）。エンドポイントが7本増える。フロントに依頼/承認 UI とバッジが増える。
- **留意**: 1人が複数チームに所属しうる（member.teamIds は配列）。自/他判定は「交差の有無」。
  受け手が複数チームの時の配属チームは既定＝先頭、指定は任意フィールドで拡張（設計 doc D5）。
- **フロント衝突**: 依存候補の絞り込み（`dependencyScopeOptions`）は `feat/fe4-parent-task-search` と
  同一ファイル。フロント PR はその改修 land 後にリベースして着手（ロードマップ 3章）。
