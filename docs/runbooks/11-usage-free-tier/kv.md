# KV 読み取り・書き込み（`kv_reads_day` / `kv_writes_day`）

[← 一覧](./README.md) ・ 無料枠: **読み取り 10 万/日・書き込み 1,000/日**（書き込みは削除・一覧も含めて小さい）・UTC 0 時リセット。超えると KV の操作がエラーになる。

## よくある原因

- 設定値やフラグをリクエストごとに KV から読む
- セッション・レート制限のカウンタを KV に書く（書き込み 1,000/日はすぐ尽きる）
- 同じ値を毎回 put する

## 使っている所の調べ方

```graphql
query($a:String!,$s:Date!,$e:Date!){viewer{accounts(filter:{accountTag:$a}){
  kvOperationsAdaptiveGroups(limit:1000,filter:{date_geq:$s,date_leq:$e}){
    sum{requests} dimensions{namespaceId actionType}
  }
}}}
```

`namespaceId` は `wrangler kv namespace list` で名前に直す。その binding 名で `grep -rn` する。

## 対策

1. 読み取り: `get(key, { cacheTtl: 300 })` や isolate 内のメモリキャッシュ。変わらない設定は vars / 定数へ
2. 書き込み: 頻繁に変わる値は D1 か Durable Object に置く。値が変わった時だけ put
3. 一覧（list）を毎回しない

## 課金が正しい時

- KV の性質（全世界で速く読める）が要る使い方で、読み取りが利用者に比例している

**Workers Paid $5/月**: 読み取り 1,000 万/月（超過 $0.50/100 万）、書き込み 100 万/月（超過 $5.00/100 万）、保存 1 GB（超過 $0.50/GB-月）。
