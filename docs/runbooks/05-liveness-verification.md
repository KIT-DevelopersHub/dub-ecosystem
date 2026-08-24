# 05 — Liveness verification（「確認して」を出す前に、本当に反映されているか機械で証明する）

> 結論: **demo/staging は単一スロット**。並行デプロイで後発が先発を上書き（clobber）し、
> レビュアーが古い/別の状態を掴む。あるいは「実装した」がスロットに実際は届いていない。
> これを潰すため、**「確認して」と出す前に、配信バンドルに機能固有のマーカーが実在するかを
> 自動検証する**。マーカーが無ければレビューに出さない。

## 1. なぜ起きていたか（原因）

| # | 原因 | 症状 |
|---|---|---|
| 1 | demo は `fe2-demo` の**単一 Worker**。各エージェントが手で `wrangler deploy` | 後発が先発を上書き → **古い状態を確認させられる** |
| 2 | staging は**単一の共有 `-staging` セット**。`stagingへ` ラベル or `main` 追従で同じ枠を奪い合う（`concurrency: cancel-in-progress`） | 別 PR / main HEAD に上書きされ、確認対象と違うものが載る |
| 3 | 「確認して」の前に**配信物を実測する手順が無かった** | 「実装した」がビルド漏れ/設定違い/レースでスロットに届かず、**未反映/未実装のデモ**を確認させる |
| 4 | 今そのスロットに**何の SHA/機能が載っているかの記録が無い** | 上書きが無記録。誰が何を消したか分からない |

## 2. 仕組み（対策）

### a. `scripts/verify-live.sh <env> <marker...>` — 配信物の実測

対象 env（`demo`/`staging`/`prod`）が**今まさに配信している** fe2 の `index.html` と、それが
参照する JS/CSS バンドルを取得し、**機能固有のマーカー（data-testid・一意文字列・ビルドスタンプ・
API フィールド）が全て存在するか**を検査する。1つでも欠ければ非ゼロ終了 = **確認に出すな**。

```
pnpm verify:live demo 'data-testid="gantt-marquee"'
pnpm verify:live staging 'マーキー選択' '一括削除'
pnpm verify:live staging --api /api/v1/me --expect-status 401 '新ボタン文言'
bash scripts/verify-live.sh --file apps/fe2-app-shell/dist/assets/index-*.js '新ボタン文言'  # ビルド直後にオフライン確認
```

終了コード: `0`=全マーカーあり(LIVE) / `3`=欠落(NOT live) / `4`=到達不能 / `2`=使い方エラー。

### b. `scripts/deploy-demo.sh --markers "<m1>,<m2>"` — demo を直列化＋記録＋検証

demo スロットに載せる**唯一の正規手段**。生の `wrangler deploy --config wrangler.demo.toml` は
使わない。1コマンドで:

1. **直列化**: マシン全体の排他ロック（`mkdir` アトミック）。並行 demo デプロイはレースせず待つ。
2. **上書き警告**: 現マニフェストの占有者(SHA/actor)を表示（レビュー中を潰していないか）。
3. **ビルド**: `VITE_DEMO=1` で fe2 をビルド。**デプロイ前に**built dist にマーカーが在るか確認
   （コード入れ忘れ/別物ビルドをスロットに触れず検知）。
4. **デプロイ** → `fe2-demo`。
5. **配信検証**: `verify-live.sh demo <markers>` で配信物を実測。欠落なら**非ゼロ終了**。
6. **マニフェスト**: `deploy-state/demo.json` に SHA/branch/actor/markers/live/時刻を記録。

```
export CLOUDFLARE_API_TOKEN=$(cat ~/Desktop/cf-token.txt)
pnpm deploy:demo --markers 'data-testid="gantt-marquee", 一括削除' --note "PR#412 ガント範囲選択"
# LIVE ✅ が出たら deploy-state/demo.json をコミット
```

### c. `deploy-state/*.json` — 「今スロットに載っているもの」の台帳

`demo.json`/`staging.json`/`prod.json` に deployed SHA・feature markers・actor・timestamp・
liveness 結果を記録。**上書きが無記録にならない**。詳細は [`deploy-state/README.md`](../../deploy-state/README.md)。

### d. staging CI の liveness ゲート

`.github/workflows/staging.yml` は staging デプロイ後、PR 本文の
`Liveness-Marker: <文字列>` を読み、**配信 staging バンドルに実在するか**を検証して結果を
sticky コメントに出す。欠落なら**ジョブを赤にする**（古い/空の staging を `確認した` に進めない）。
トレーラ未記入なら skip（後方互換）。

## 3. 「確認して」依頼テンプレート（必須チェックリスト）

demo/staging を人に確認依頼する時は、判断カードに**必ず**次を載せる（[[verify-request-url-and-checklist-table]]）。

```
確認環境: <demo|staging> URL = https://fe2-demo.developershub-site.workers.dev
対象機能: <1行>
Before / After: <何がどう変わるか。可能なら画像>
本番との差: <prod と何が違うか。無ければ「なし」>
liveness 証跡: verify-live PASS（マーカー: <string>） / deploy-state/<env>.json の live=true
確認手順(表):
| # | 操作 | 期待 |
|---|---|---|
| 1 | ランチャー → ○○ | △△ が出る |
```

**ゲート: liveness 証跡（verify-live PASS もしくは manifest live=true）が無い確認依頼は出さない。**

## 4. 運用ルール（要点）

- demo は `pnpm deploy:demo --markers ...` のみ。**生 `wrangler deploy` 禁止**。
- staging に上げる PR（UI/機能）は本文に `Liveness-Marker:` を書く。
- 「確認して」の前に必ず `pnpm verify:live <env> <marker>` を通す。PASS の証跡を依頼に添える。
- 単一スロットは早い者勝ちで奪い合う。デプロイ前に `deploy-state/<env>.json` を見て、
  レビュー中を上書きしないか確認する。

## 5. 並行開発フロー（使い捨て per-feature demo → staging バッチ）

複数エージェントが並行で開発する場合、共有 `fe2-demo` 単一スロットを奪い合う代わりに、**機能ごとに
使い捨ての専用 demo Worker `dub-demo-<slug>`** を立てて単独レビューし、承認後は削除する。承認済みは
staging キューに貯めて**5件 / 24h / 手動**で一括フラッシュする。手順は [06-parallel-demo-staging-flow.md](./06-parallel-demo-staging-flow.md)（`deploy:demo:feature` / `teardown:demo` / `staging:queue`）。
本 runbook の verify-live / deploy-state 台帳がその土台。

関連: [06-parallel-demo-staging-flow.md](./06-parallel-demo-staging-flow.md) / [04-staging-label-gate.md](./04-staging-label-gate.md) / [01-deploy.md](./01-deploy.md) / [../DEPLOY.md](../DEPLOY.md)
