# 北陸ITカンファレンス ガント — 本番 D1 シード手順

`conference-gantt.sql` は、DevelopersHub の北陸ITカンファレンス運営ロードマップ（LMB の実データ）を
task-service の D1 に投入するための **手動シード** です。デモ用の `apps/fe4-task-gantt/src/dev-seed.ts`
と同一の実データ（41 セクション work-package / 7 チーム / 6 フェーズ）から生成しています。

## 出典（LMB リポジトリ）

- `leaders-meetup-bot/scripts/data/2026-07-22-gantt-team-reassign.sql` — summaryGroups 構成（41 グループ / 129 WBS）と実依存
- `leaders-meetup-bot/scripts/data/2026-07-22-gantt-honbu-process-labels.sql` — 本部チームの実タスク名
- `leaders-meetup-bot/migrations/0077_gantt_tracker.sql` — team/phase/wbs スキーマ
- Event: カンファレンス2027 `acd75449-c875-4c13-83d8-2dd8f8ce8a33`

## 前提・注意

- **本番 `dub-core` には流さない**。まず preview / staging の D1 で検証すること（seedScenario の prod ガードと同じ方針）。
- `task_tasks` に `team_id` 列がまだ無いため、チーム／担当は `description`（`WBS x.y ・ Fn ・ チーム ・ 担当:氏名`）に記録している。
  task-service が team 列を追加したら、この SQL に `team_id` を足して再生成する。
- 開始／終了日は gantt-service が `due_at` + 依存（CPM）から算出するため、ここでは `due_at` のみ投入する。
- 冪等（`INSERT OR REPLACE`）。同じ id で何度流しても安全。

## 実行方法

```
# ローカル D1 でドライラン
wrangler d1 execute <DB_NAME> --file infra/d1/seed/conference-gantt.sql --local

# preview / staging の D1 に投入
wrangler d1 execute <DB_NAME> --file infra/d1/seed/conference-gantt.sql --remote
```

## 再生成

デモ seed（`apps/fe4-task-gantt/src/dev-seed.ts`）が唯一の実データ定義。セクション／依存を更新したら、
同じ配列でこの SQL を作り直す（このリポジトリのデモ seed と本番 SQL を一致させる）。
