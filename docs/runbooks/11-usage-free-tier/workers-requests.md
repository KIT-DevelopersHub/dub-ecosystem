# Workers リクエスト（`workers_requests_day`）

[← 一覧](./README.md) ・ 無料枠: **10 万リクエスト/日（アカウント全体）**・UTC 0 時リセット。超えると Worker が 1027 エラーを返し（ルートの fail mode が closed の時。open なら Worker を通らずオリジンへ素通り）、**全サービスが止まる**。

## よくある原因

- fe2 / モバイルの短い間隔のポーリング（未読数・同期）が人数ぶん積み上がる
- Service Binding の連鎖: api-gateway → 各サービス → identity と、1 操作で 3〜5 回数えられる
- 静的アセットを Worker で返している
- bot・監視・外形監視（canary）のアクセス

## 使っている所の調べ方

Worker 別（`s` / `e` は日時。`orderBy` は付けない）:

```graphql
query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){
  workersInvocationsAdaptive(limit:1000,filter:{datetime_geq:$s,datetime_leq:$e}){
    sum{requests} dimensions{scriptName}
  }
}}}
```

上位の Worker が分かったら、その Worker のログ（`wrangler tail <name>` / Observability）でパスを見る。

## 対策

1. ポーリング間隔を延ばす・画面が見えている時だけ取る・変化があった時だけ取りに行く
2. 1 操作で何度も Service Binding を呼ぶ所をまとめる（BFF で 1 回にする）
3. 静的アセットは Workers Assets（Worker の実行に数えない）で返す
4. bot は WAF ルール・レート制限で落とす

## 課金が正しい時

- 呼び出しの大半が利用者の正当な操作で、間隔を延ばすと使い勝手が落ちる

**Workers Paid $5/月**: 1,000 万リクエスト/月込み、超えた分は $0.30/100 万。CPU 時間は 3,000 万 ms/月込み（超過 $0.02/100 万 ms）。
D1 / KV / DO も同時に従量になる。
