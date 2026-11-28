# D1 行書き込み（`d1_rows_written_day`）

[← 一覧](./README.md) ・ 無料枠: **10 万行/日**（UTC 0 時リセット）・超えると書き込みが全部エラーになる（読むだけの画面は動く）。

## よくある原因

- outbox（freeq）・通知・監査ログ・同期の UPSERT が、変わっていない行まで毎回書く
- インデックスが多いテーブル: 1 行の INSERT/UPDATE は「テーブル + インデックスの数」行の書き込みになる
- 定期処理（cron / DO alarm）が全件を書き直す
- 取り込み（Slack 履歴・メール取り込み）を一度に流した

## 使っている所の調べ方

```graphql
query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){
  d1QueriesAdaptiveGroups(limit:25,filter:{datetime_geq:$s,datetime_lt:$e},orderBy:[sum_rowsWritten_DESC]){
    sum{rowsRead rowsWritten} count dimensions{databaseId query}
  }
}}}
```

`rowsWritten / count` が 1 回あたり。`INSERT` / `UPDATE` / `DELETE` の文字列でコードを探す。

## 対策

1. 差分だけ書く（`UPDATE ... WHERE col IS NOT ?` / 値が同じなら書かない）
2. 使っていないインデックスを消す（書き込み 1 行あたりの数が減る。読み取りが増えないか先に確かめる）
3. ログ・計測は日次集計にまとめる・古い行の削除はまとめて夜に流す
4. 一括取り込みは日をまたいで分ける（1 日 10 万行を超えない量に区切る）

## 課金が正しい時

- 書き込みが「利用者の操作そのもの」（チャット・タスク更新）で、減らすと機能が欠ける

**Workers Paid $5/月**: 5,000 万行/月まで込み、超えた分は $1.00/100 万行。Workers / KV / DO も従量になる点は[一覧](./README.md)を参照。
