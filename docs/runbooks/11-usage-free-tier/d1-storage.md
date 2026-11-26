# D1 ストレージ（`d1_storage`）

[← 一覧](./README.md) ・ 無料枠: **アカウント全体で 5 GB**（1 DB あたり 500 MB）・リセットなし（累積）。超えると書き込みがエラーになる。
画面と Issue は過去 7 日の増え方から「満杯になる日」を見積もる。

## よくある原因

- メール本文・添付・生 webhook など大きい値を D1 に入れている
- ログ・送信履歴・監査に保持期限が無い
- staging / demo 用の D1 を作ったまま消していない

## 使っている所の調べ方

DB 別の大きさ:

```graphql
query($a:String!,$s:Date!,$e:Date!){viewer{accounts(filter:{accountTag:$a}){
  d1StorageAdaptiveGroups(limit:1000,filter:{date_geq:$s,date_leq:$e}){
    max{databaseSizeBytes} dimensions{databaseId date}
  }
}}}
```

テーブル別は D1 に直接聞く（読み取りのみ。本番で流す時は人が判断する）:

```sh
pnpm dlx wrangler@4.35.0 d1 execute <db> --remote --json \
  --command "SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 20"
```

## 対策

1. 大きい値は R2 に置き、D1 にはキーだけ持つ
2. 保持期限を決めて古い行を消す（ログ・送信履歴・生 webhook）
3. 使っていない staging / demo の D1 を消す（`wrangler d1 list` で確認）

## 課金が正しい時

- 消せないデータ（会員・メール本文の保存が要件）が増え続けている

**Workers Paid $5/月**: 5 GB 込み、超えた分は $0.75/GB-月（1 DB の上限は 10 GB に上がる）。
