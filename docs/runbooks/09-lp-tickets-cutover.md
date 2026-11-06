# 09 — LP チケット販売の切り替え（dub-lp-analytics → dub-lp-tickets）

> 結論: **販売を止める → D1 を作ってコピー → main マージ → LP Worker をデプロイ → 件数を照合 → 販売再開** の順に行う。
> 理由: コードは Worker の入れ替えと同時に新しい D1 を読むので、先にデータが揃っていないと注文が消えて見える。
> `dub-core` の `lp_ticket_*` は消さないので、再開前なら何も失わずに戻せる。

この手順のうち本番に触る工程はオーナーが行う。PR の main マージには通常どおり `確認した` が要る。

## 0. 全体の順序と理由

| # | 工程 | 実行者 | 止まると何が起きるか |
|---|---|---|---|
| 1 | staging で通し確認 | オーナー / CI | 本番に影響なし |
| 2 | 本番の販売を止める | オーナー | 購入を受けたままコピーすると注文を落とす |
| 3 | `dub-tickets` を作りスキーマを適用 | オーナー | 影響なし（まだ誰も読まない） |
| 4 | Stripe の secret を入れる | オーナー | 販売停止中なら影響なし |
| 5 | データをコピーして照合 | オーナー | 影響なし（`dub-core` は読むだけ） |
| 6 | id を PR に入れて main マージ | オーナー + CI | 工程 7 が終わるまで LP のチケット画面は「準備中」 |
| 7 | LP Worker をデプロイ | オーナー | 同上 |
| 8 | 照合と動作確認 | オーナー | 影響なし |
| 9 | 販売再開 | オーナー | ここで初めて `dub-tickets` に新しい注文が入る |

`deploy-prod.sh` は LP Worker を含まないので、工程 7 は手で行う。
`database_id` が `REPLACE_AT_CUTOVER` のまま main に入ると、`deploy-prod.sh` は最初に止まり、その間は**全サービスの本番デプロイが止まる**。工程 6 の id の差し替えを必ず同じ PR に含める。

## 1. staging で通し確認

```sh
export CLOUDFLARE_API_TOKEN=...   # D1:Edit / Workers Scripts:Edit
for sfx in -staging -staging2; do
  pnpm dlx wrangler@4.35.0 d1 create "dub-tickets${sfx}"
  pnpm dlx wrangler@4.35.0 d1 execute "dub-tickets${sfx}" --remote --yes --file services/lp-tickets/db/0001_init.sql
done
```

1. 表示された id を `infra/deploy/staging-resources.env` と `staging2-resources.env` の `STAGING_TICKETS_D1_ID` に入れてコミットする。`setup-staging-resources.sh` でも作れるが、`dub-core-staging` の seed もやり直すので既存環境では使わない。
2. テストキーを入れる（`dub-lp-tickets-staging` と `-staging2`。deploy は secret を設定しない）。
3. PR に staging ラベルを付けて反映し、`lp-conference-next-preview` を手でデプロイする。
4. LP管理のチケット画面、公開設定の本番反映、プレビューからのテスト購入、Stripe テスト webhook を確かめる。

既存の staging のチケットデータは移さない（デモ用途のため空から始める）。

## 2. 本番の販売を止める

1. LP管理 → チケットで販売を off にする。CTA の差し替えも off にする。
2. 開いている Checkout が閉じるまで **45 分以上**待つ（セッション 31 分 + 照合の周期）。
3. `pending` が 0 件になったことを確かめる。

```sh
pnpm dlx wrangler@4.35.0 d1 execute dub-core --remote --json --command \
  "SELECT status, COUNT(*) AS n FROM lp_ticket_orders GROUP BY status"
```

`pending` を残したまま進めない。工程 6 で旧 Worker の照合 alarm が破棄され、新しい alarm は次の有料 checkout まで動かないので、残った注文を照合するものが無くなる。

## 3. dub-tickets を作る

```sh
pnpm dlx wrangler@4.35.0 d1 create dub-tickets
pnpm dlx wrangler@4.35.0 d1 execute dub-tickets --remote --yes --file services/lp-tickets/db/0001_init.sql
```

## 4. secret を入れる

```sh
pnpm dlx wrangler@4.35.0 secret put STRIPE_SECRET_KEY --name dub-lp-tickets
pnpm dlx wrangler@4.35.0 secret put STRIPE_WEBHOOK_SECRET --name dub-lp-tickets
```

- 値は `dub-lp-analytics` に入れたものと同じ。Cloudflare からは読み出せないので、Stripe ダッシュボードか手元の保管場所から取る。
- Worker がまだ無いと作成を聞かれるので作る。失敗したら工程 6 の直後に入れてよい（販売停止中なので購入には影響しない。Stripe の webhook は再送される）。
- 本番キーを使っている場合は `STRIPE_ALLOW_LIVE` も必要。`wrangler secret list --name dub-lp-analytics` とダッシュボードの変数で今の入れ方を確かめ、同じ値を `dub-lp-tickets` に入れる。入れ忘れると決済準備中のままになる。`LP_PAYPAY_ENABLED` も同じ。
- Stripe の webhook URL は変えない（公開 LP の `/tickets/stripe-webhook` のまま）。

## 5. コピーして照合する

```sh
bash services/lp-tickets/scripts/copy-from-dub-core.sh --i-have-stopped-sales
```

スクリプトは書き込み前に、販売 off・`pending` 0 件・コピー先が空・列の並びの一致を確かめ、1 つでも外れたら何も書かずに止まる。テーブルごとに `d1 export` → `d1 execute` → 件数と status 別の照合を行う。

- `d1 export` の実行中は `dub-core` の他のリクエストが待たされることがある。アクセスの少ない時間に行う。
- 書き出しには購入者の個人情報が入る。スクリプトは一時ディレクトリに置いて終了時に消す。別の場所へ保存しない。
- 途中で失敗したら `dub-tickets` の 5 テーブルを空にしてからやり直す。

## 6. id を入れて main マージ

1. `services/lp-tickets/wrangler.free.toml` と `wrangler.toml` の `REPLACE_AT_CUTOVER` を工程 3 の id に置き換えて PR に積む。
2. オーナーが `確認した` を付けて main へマージする。
3. `deploy.yml` が `dub-tickets` のスキーマゲートのあと、`lp-tickets` → `lp-analytics` → `api-gateway` の順にデプロイする。`lp-analytics` の v2 migration でここに旧 DO が消える。

この時点から工程 7 が終わるまで、LP のチケット画面は「準備中」になる。Stripe の webhook は失敗扱いになり、Stripe が再送する。

## 7. LP Worker をデプロイ

```sh
pnpm --filter @dub/lp-conference-next build:bundle
pnpm dlx wrangler@4.35.0 deploy --config apps/lp-conference-next/wrangler.toml
```

## 8. 照合と確認

```sh
bash services/lp-tickets/scripts/copy-from-dub-core.sh --verify-only
```

工程 5 のあとに届いた返金・チャージバックの webhook は `dub-core` に書かれている場合がある。`DIFF` が出たら Stripe の該当イベントを確かめて `dub-tickets` の行を直すか、ダッシュボードから webhook を再送する。

確認項目:

- LP管理のチケット画面に券種・売上・購入者が以前と同じ件数で出る
- 公開設定の画面が開き、販売状態が off で表示される
- `https://hokuriku-it-conf.com/tickets` が販売停止の表示になる（`?tickets=on` のプレビューで券種が出る）
- 登壇者募集の応募が通る（LP_FLAG のまま）
- `paymentReady` が true（false なら secret か `STRIPE_ALLOW_LIVE` の入れ忘れ）

## 9. 販売再開

LP管理で販売と CTA を元に戻す。最初の有料 checkout で照合 alarm が動き始める。Stripe ダッシュボードで webhook の成功を確かめる。

## 10. 後片付け（別 PR）

十分に動いたことを確かめてから行う。

- `dub-lp-analytics` の Stripe secret を消す
- `infra/d1/migrations/lp/` の `lp_ticket_*` を落とす migration と `registry.ts` の整理（`dub-core` のデータはそれまで残す）
- `staging-schema-sync.yml` は `dub-core` だけを見る。`services/lp-tickets/db/` に新しい SQL を足した時は staging にも手で適用する

## ロールバック

結論: **販売再開前なら Worker を戻すだけ。再開後は新しい注文を書き戻してから戻す。**

- **工程 5 まで**: 何もデプロイしていない。販売を on に戻す。`dub-tickets` は空にしておく。
- **工程 6〜8（販売再開前）**: PR を revert して main にマージし、LP Worker を前の版へ戻す。`dub-core` のデータはそのまま使える。
- **工程 9 以降**: 販売を止め、`dub-tickets` で増えた注文と変わった status を `dub-core` へ書き戻してから上と同じように戻す。`SRC_DB` / `DST_DB` を入れ替えたスクリプトは、コピー先が空でないので使えない。差分だけ手で流す。

revert の注意: `lp-analytics` の DO は v2 で削除済みなので、単純な revert では `v1` しか残らず migration が食い違う。revert する PR で `wrangler.free.toml` の `v1` / `v2` を残し、次を足す。

```toml
[[migrations]]
tag = "v3"
new_sqlite_classes = ["TicketReconcileDO"]
```
