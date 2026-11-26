# D1 行読み取り（`d1_rows_read_day`）

[← 一覧](./README.md) ・ 無料枠: **500 万行/日**（UTC 0 時 = 日本時間 9 時にリセット）・超えると D1 のクエリがエラーになり、D1 を使う画面がほぼ全部止まる。

## よくある原因

- インデックスが効かず、テーブルを全部なめている（`WHERE` / `ORDER BY` の列にインデックスが無い）
- 一覧を出すたびに `COUNT(*)` で全件数える（2026-11 のメール一覧・#911）
- 相関サブクエリ（行ごとに `MAX(...)` を引く）や全件 `GROUP BY`（usage-meter の `readLatestSnapshot`・#911）
- 短い間隔のポーリング（未読数・同期）が人数ぶん積み上がる
- 1 回の権限チェックで全ロール×全権限を JOIN する（identity の `getRolesByIds`・#911）

1 行読むのは「返した行」ではなく「**調べた行**」。インデックスで 3 行しか触らなければ 3 行、全件スキャンなら全行。

## 使っている所の調べ方

クエリ別の上位（PR #911 で使ったもの。`s` / `e` は日時）:

```graphql
query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){
  d1QueriesAdaptiveGroups(limit:25,filter:{datetime_geq:$s,datetime_lt:$e},orderBy:[sum_rowsRead_DESC]){
    sum{rowsRead rowsWritten queryDurationMs} count dimensions{databaseId query}
  }
}}}
```

DB 別・日別（`s` / `e` は日付）:

```graphql
query($a:String!,$s:Date!,$e:Date!){viewer{accounts(filter:{accountTag:$a}){
  d1AnalyticsAdaptiveGroups(limit:50,filter:{date_geq:$s,date_leq:$e},orderBy:[sum_rowsRead_DESC]){
    sum{rowsRead readQueries} dimensions{databaseId date}
  }
}}}
```

見方: `rowsRead / count` が 1 回あたりの読み取り行数。**1 回あたりが大きいもの**はインデックス・書き換え、
**回数が多いもの**は呼び出し元（ポーリング・権限チェック）を直す。`query` の文字列で `grep -rn` してコードを探す。
手元で `EXPLAIN QUERY PLAN` を当て、`SCAN` が出たらインデックスが効いていない。

## 対策（効く順）

1. 上位クエリに合うインデックスを足す（`CREATE INDEX IF NOT EXISTS`・追加だけなので安全）。migration は
   `infra/d1/migrations/<namespace>/` に置き、`packages/e2e-smoke/src/d1.ts` に sqlFile を足す
2. `COUNT(*)` をやめる・使い回す（別の API で既に数えている値を使う、上限付き件数「99+」にする）
3. 相関サブクエリ・全件集計を、範囲を絞った `GROUP BY` + `JOIN` に書き換える
4. ポーリング間隔を延ばす（fe2 の `refetchInterval`、Service Worker の定期同期）・画面が見えている時だけ取る
5. 権限・設定など変わりにくい値は isolate 内でキャッシュする（数十秒でも効く）

## 課金が正しい時

- 上位が「正しく絞れたクエリ × 人数ぶんの回数」で、利用者の増加そのものが原因
- 1 回あたり数行まで減らしても注意以上が続く

**Workers Paid $5/月**: 250 億行/月まで込み、超えた分は $0.001/100 万行。今の使い方（〜500 万行/日 = 1.5 億行/月）なら
$5 の固定費だけで収まる。ただし Workers / KV / DO も含めて上限で止まらなくなる（[一覧の注意](./README.md#項目別の手順書)）。
