# 10 — チケット購入〜当日受付の E2E と、壊れた時の戻し方

> 結論: **購入 → 決済 → 発券 → 受付** は E2E テストで毎回確かめる。壊れたら **販売を止める → 原因の Worker を前の版へ戻す → 取りこぼした注文を照合で拾う** の順に戻す。
> 当日の受付は、受付画面が動かなくても **注文番号の手入力** と **購入者 CSV** で続けられる。

本番に触る工程（Worker の rollback・D1 の復元・Stripe ダッシュボード）はオーナーが行う。E2E は本番キー・本番 D1 を一切使わない。

## 0. E2E が守っているもの

| 段 | 何を確かめるか | API 版（vitest） | ブラウザ版（Playwright） |
|---|---|---|---|
| 購入 | 公開 LP `/tickets` に券種が出て、フォーム送信で Checkout へ進む | ✓ | ✓ |
| 決済 | Stripe テストモードで支払い → 署名付き webhook → 注文が paid。拒否カードでは券が出ない | ✓ | ✓（拒否カード → テストカード） |
| 無料 | 0 円の注文は Stripe を通らずに完了する（クーポン経由も） | ✓ | ✓ |
| 発券 | 完了ページ・確認メールのチケット URL・チケットページ・QR 画像 | ✓ | ✓ |
| 受付 | QR の中身（URL）/ 注文番号で受付 → OK。同じ券は「受付済み」で拒否。件数が増えない | ✓ | ✓（fe2 `/lp/checkin`） |
| 守り | 偽の QR・不明なコード・権限の無い利用者・署名が違う webhook を拒否 | ✓ | — |
| 復旧 | webhook が届かない時に照合（cron）・完了ページで拾える／webhook 再送で二重発券しない／返金した券は受付で無効 | ✓ | — |
| 安全 | `sk_live_` / `rk_live_` を渡すと起動しない。`services/lp-tickets/db` の migration を全部当てている | ✓ | — |

本物のコードをそのままつなぐ: 公開 LP Worker（`apps/lp-conference-next/worker`）→ lp-tickets（`services/lp-tickets`）→ D1（node:sqlite に `services/lp-tickets/db/*.sql` を全部当てたもの）。偽物は Stripe API（テストモードだけを受ける）・メール送信・api-gateway の 3 つだけ。

| ファイル | 役割 |
|---|---|
| `packages/e2e-smoke/src/ticket-stack.ts` | スタック本体（偽 Stripe・署名付き webhook・受付の呼び出し） |
| `packages/e2e-smoke/test/ticket-to-checkin.test.ts` | API 版。1 秒以内 |
| `packages/e2e-smoke/src/ticket-server.ts` | スタックを HTTP で公開（ブラウザ版用） |
| `apps/fe2-app-shell/e2e/ticket-to-checkin.spec.ts` | ブラウザ版。`playwright.tickets.config.ts` |
| `.github/workflows/ticket-flow-e2e.yml` | CI |

### 回し方

```sh
# API 版（毎 PR の `pnpm run test` にも入っている）
pnpm --filter @dub/e2e-smoke exec vitest run test/ticket-to-checkin.test.ts

# ブラウザ版（初回だけ依存のビルドと Chromium）
cd apps/fe2-app-shell
pnpm exec turbo run build --filter=@dub/fe2-app-shell^...
pnpm exec playwright install chromium
pnpm run e2e:tickets
```

CI（`ticket-flow-e2e.yml`）が回る時:

- main への push（チケット・受付まわりのファイルが変わった時）
- PR に **`チケットE2E`** ラベルを付けた時（付けている間は push ごと）
- 毎朝 06:00 JST の定期実行と手動実行

PR 以外で失敗すると、Issue「チケット購入〜受付の E2E が失敗しています」（`area:tickets` / `P0`）が立つか、開いている同じ Issue にコメントが付く。失敗時は Playwright の trace が artifact `ticket-flow-e2e-traces` に残る。

### 新しい migration を足した時

`services/lp-tickets/db/` に SQL を足したら、`packages/e2e-smoke/src/d1.ts` の `ticketsSchemas()` に 1 行足す。足し忘れると E2E の「applies every dub-tickets migration」が赤くなる。共有 D1（`dub-core`）の migration は従来どおり `allSchemas()` へ。

## 1. まず確かめる（どこが壊れたか）

| 症状 | 見る所 | 次へ |
|---|---|---|
| `/tickets` が開かない・「準備中」 | LP Worker `lp-conference-next` のログ / LP管理の販売状態 | 3 |
| 決済後に完了ページが「確認中」のまま・メールが来ない | Stripe ダッシュボードの webhook 配信結果 / `dub-lp-tickets` のログ（`lp ticket reconcile finished`） | 2 |
| 注文が `needs_review` | 席数を超えた同時購入。LP管理の購入者一覧 | 2 |
| 受付画面でエラー | fe2 / api-gateway / `dub-lp-tickets` のログ | 4 |
| E2E だけ赤い | 直前の PR の差分。trace の該当ステップ | 3 |

## 2. 注文と発券を直す（Worker は戻さない）

- **webhook が届かなかった**: 何もしなくても照合（`TicketReconcileDO` の alarm、約 10 分ごと）が Stripe に問い合わせて paid にし、メールを送る。急ぐ時は Stripe ダッシュボードの該当イベントから webhook を**再送**する。再送しても二重発券・二重メールにならない（E2E で確認済み）。
- **購入者が完了ページを開いた**: その時点でサーバーが Stripe に確認して確定する。
- **`needs_review`**: LP管理の購入者一覧で「承認」（`POST /lp/tickets/orders/:id/approve`）するか返金する。
- **返金**: LP管理から返金すると、その券は受付で「無効」になる。
- **購入記録を手で直す**: 直接 D1 を書き換える前に、上の 3 つで直らないかを確かめる。どうしても必要な時は販売を止め、`dub-tickets` に対して 1 行に絞った UPDATE を前後の SELECT 付きで流す。

## 3. Worker を前の版へ戻す

結論: **戻すのは壊した Worker だけ。D1 は戻さない**（注文と受付の記録は残す）。

| Worker | 役割 | 設定 |
|---|---|---|
| `dub-lp-tickets` | 注文・決済・発券・受付の API | `services/lp-tickets/wrangler.free.toml` |
| `lp-conference-next` | 公開 LP（`/tickets`・`/t/<券>`・webhook の入口） | `apps/lp-conference-next/wrangler.toml` |
| `dub-fe2-app-shell` | 受付画面（`/lp/checkin`） | `apps/fe2-app-shell` |
| `dub-api-gateway` | fe2 → lp-tickets の中継 | `services/api-gateway/wrangler.free.toml` |

1. LP管理で販売を止める（受付だけ壊れている時は止めない）。
2. 直前の版へ戻す。

   ```sh
   export CLOUDFLARE_API_TOKEN=...   # Workers Scripts:Edit
   pnpm dlx wrangler@4.35.0 deployments list --name dub-lp-tickets
   pnpm dlx wrangler@4.35.0 rollback <version-id> --name dub-lp-tickets -m "rollback: ticket flow broken (#897)"
   # 公開 LP の時は --name lp-conference-next
   ```

3. 原因の PR を revert する PR を出して main に入れる（次の `deploy-prod.sh` で壊れた版に戻らないように）。
4. **確かめる**（4 つとも見る）:
   - `https://hokuriku-it-conf.com/tickets` に券種が出る
   - LP管理の購入者一覧が開き、件数が戻す前と同じ
   - 受付画面で、テスト用の券（またはその日まだ受付していない券）の注文番号を手入力して「受付しました」。すぐ「取り消す」
   - main の `Ticket flow E2E` を手動実行して緑
5. 販売を再開し、Stripe ダッシュボードで次の webhook が成功するのを確かめる。止めていた間の pending は照合が拾う。

D1 のデータ自体が壊れた時だけ `09-lp-tickets-cutover.md` の「バックアップからの復元」（Time Travel / R2 日次 JSON）を使う。Time Travel は復元時刻より後の注文・受付を消すので、先に Stripe ダッシュボードと注文を突き合わせてから行う。

## 4. 当日、受付画面が使えない時

受付を止めない。直すのは並行で行う。

1. **別の端末・別の回線**で `/lp/checkin` を開き直す（カメラが動かない時は手入力欄に注文番号 `ABCD1234-1` を入れる）。
2. それでも動かない時は、開場前に出しておいた**購入者 CSV**（LP管理 → チケット →「CSV を書き出す」）で名前と注文番号を照らして通し、紙に印を付ける。
3. 復旧したら紙の分を手入力で受付済みにする（同じ券を二度入れても「受付済み」になるだけで件数は増えない）。読み間違えた分は直後の「取り消す」で戻せる。

開場前日までにやっておくこと:

- 購入者 CSV を書き出して受付に置く
- 受付係のロールに `lp:checkin` が付いているかを確かめる（無いと受付画面に「受付の権限がありません」）
- `Ticket flow E2E` を手動実行して緑を確かめる
