# Durable Objects / Queues（`do_requests_day`）

[← 一覧](./README.md) ・ 無料枠: **Durable Objects 10 万リクエスト/日**（SQLite 版）・実行時間 13,000 GB-s/日・UTC 0 時リセット。
超えると DO を使う機能（usage-meter の日次収集・github-sync の照合・リアルタイム系）が止まる。

## Queues について

Dub は Cloudflare Queues（有料寄り）を使っていない。代わりに **freeq**（`packages/freeq`・D1 の outbox を cron / DO alarm で流す）を使う。
そのため「キューが重い」は **D1 の行読み書き**と **DO / Workers のリクエスト**として現れる。
freeq の drain が多い時は [d1-rows-written.md](./d1-rows-written.md) と [workers-requests.md](./workers-requests.md) も見る。

## よくある原因

- DO alarm の間隔が短い・alarm が失敗して何度も再試行される
- WebSocket のメッセージ 1 通ごとに DO が起きる（Hibernation API を使っていない）
- 1 つの操作で同じ DO を何度も fetch する

## 使っている所の調べ方

```graphql
query($a:String!,$s:Date!,$e:Date!){viewer{accounts(filter:{accountTag:$a}){
  durableObjectsInvocationsAdaptiveGroups(limit:1000,filter:{date_geq:$s,date_leq:$e}){
    sum{requests} dimensions{scriptName}
  }
}}}
```

上位の Worker の `wrangler.free.toml` で DO の class 名を見て、`alarm()` と `fetch()` の呼び出し元を探す。

## 対策

1. alarm の間隔を延ばす・必要な時だけ setAlarm する・alarm で例外を投げない（再試行が増える）
2. WebSocket は Hibernation API（`state.acceptWebSocket`）にして、ping を DO に届けない
3. freeq の drain 間隔・1 回あたりの件数を見直す

## 課金が正しい時

- リアルタイム機能（チャット等）の利用者が増え、メッセージ数に比例している

**Workers Paid $5/月**: DO 100 万リクエスト/月込み（超過 $0.15/100 万）、実行時間 40 万 GB-s/月込み（超過 $12.50/100 万 GB-s）。
Queues を使う場合も Workers Paid で 100 万操作/月込み（超過 $0.40/100 万）。Workers / D1 / KV も同時に従量になる。
