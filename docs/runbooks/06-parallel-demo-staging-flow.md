# 06 — 並行開発の環境フロー（使い捨て per-feature demo → 承認 → staging 5件バッチ）

> 結論: 並行開発では**共有 `fe2-demo` 単一スロットを奪い合わない**。機能ごとに**使い捨ての専用
> demo Worker `dub-demo-<slug>`** を立て、単独レビュー→承認→**teardown で即削除**する。承認済み機能は
> **staging キュー**に貯め、**フラッシュ条件（5件 / 24h / 手動）**が立ったら統合ブランチに一括マージして
> **staging へ1回だけ反映**する（demo=staging 一致）。これで「demo却下がstagingに混入」「単一スロットの
> 上書き」「Worker 枠の浪費」を同時に潰す。前提は [05-liveness-verification.md](./05-liveness-verification.md)。

関連ルール: [[dub-demo-first-then-staging]] [[dub-epic-branch-workflow]] [[dub-approval-ship-no-re-review]] / `~/.claude/rules/dub-development-flow.md`

## 0. 全体像

```
main (or 確定統合)  +  その1機能だけ  ──deploy-demo-feature──▶  dub-demo-<slug>  (使い捨て)
                                                                     │  レビュー(URL共有)
                                            却下 ◀──────────────────┤
                                                                     │ OK
                                    staging-queue add <slug> ◀───────┘  +  teardown-demo <slug>(Worker削除)
                                                                     │
                        （5件 / 最古24h / 手動フラグ）──flush──▶ 統合ブランチに一括マージ→staging 1回反映→verify-live
```

- **1 demo = 1 機能**。base はクリーンな `main`（または確定済み統合）に**その機能ブランチだけ**を載せた状態。
- demo は**フロント + アプリ内 mock/seed のみ**（`VITE_DEMO=1`）。gateway/D1/実backendを一切叩かない＝**無料**。
- 各 demo は**固有の Worker 名**なので互いに上書きしない（共有スロットの直列ロックは不要）。

## 1. per-feature demo を立てる

```bash
export CLOUDFLARE_API_TOKEN=$(cat ~/Desktop/cf-token.txt)
# その1機能ブランチをチェックアウトした状態で:
pnpm deploy:demo:feature --slug gantt-marquee \
  --markers 'data-testid="gantt-marquee", 一括削除' \
  --note "PR#412 ガント範囲選択"
```

やること（1コマンド）:
1. `VITE_DEMO=1` で fe2 をビルドし、**デプロイ前に**built dist にマーカー実在を確認（入れ忘れ/別物ビルドを検知）。
2. `dub-demo-gantt-marquee` という**固有 Worker** にデプロイ（`wrangler deploy --name` 上書き）。
3. `verify-live.sh --url` で**配信物**にマーカー実在を実測（欠落なら非ゼロ終了＝確認に出さない）。
4. `deploy-state/demo-gantt-marquee.json` に SHA/branch/actor/markers/live/URL を記録。
5. 共有 URL `https://dub-demo-<slug>.developershub-site.workers.dev` を出力。

事前に計画を見るなら `--dry-run`（何もビルド/デプロイ/書き込みしない）。`--no-build` で既存 dist 再利用。

**確認依頼**は 05 の必須チェックリスト（URL＋確認表＋liveness証跡）に従う。demo は backend-free なので「本番との差」に mock 前提を明記。

## 2. 承認 → staging キューに積む

demo URL がレビューで **OK** になったら、承認を台帳に記録:

```bash
pnpm staging:queue add gantt-marquee \
  --branch fe4/gantt-marquee \
  --markers 'data-testid="gantt-marquee", 一括削除' \
  --demo-url https://dub-demo-gantt-marquee.developershub-site.workers.dev
```

- `--branch` は flush 時に統合ブランチへマージする**クリーンな機能ブランチ**（demoでOKした版そのもの）。
- 台帳は `deploy-state/staging-queue.json`。同一 slug は upsert（重複行を作らない＝台帳SoTと整合）。
- **却下**された機能は add しない（`demo却下(要修正)` のまま。stagingへ絶対に進めない）。

## 3. 使い捨て demo を teardown（残骸ゼロ・無料枠を守る）

承認して add したら、その demo Worker はもう不要。**即削除**:

```bash
pnpm teardown:demo gantt-marquee            # 確認プロンプトあり
pnpm teardown:demo gantt-marquee --yes      # CI/スクリプト用（無確認）
pnpm teardown:demo gantt-marquee --dry-run  # 計画だけ表示
```

`wrangler delete --name dub-demo-<slug>` で Worker を消し、`deploy-state/demo-<slug>.json` を削除。
**無料枠**: Cloudflare 無料プランは Worker スクリプト数に上限（〜100）。使い捨て demo は消すまで1枠を占有するため、
承認後は必ず teardown する。`deploy-demo-feature.sh` は既存 `demo-*.json` が `DEMO_SOFT_LIMIT`(既定20)以上に
なると警告する。

## 4. staging キューの状態確認とフラッシュ

```bash
pnpm staging:queue status          # 件数・各機能の経過時間・フラッシュ可否と理由
pnpm staging:queue status --json   # 機械可読
```

**フラッシュ条件（いずれか1つ）**:

| # | 条件 | 既定 | 変更 |
|---|---|---|---|
| 1 | キュー件数 ≥ しきい値 | 5 | `staging-queue.json` の `flushThreshold` |
| 2 | 最古の承認からの経過 ≥ maxAge | 24h | `maxAgeHours` |
| 3 | 手動フラグ | off | `pnpm staging:queue set-manual-flush on` |

条件が立ったら flush で**統合手順（マージ→デプロイ計画）**を出す:

```bash
pnpm staging:queue flush --dry-run   # 計画だけ（台帳は不変）
pnpm staging:queue flush             # 台帳を flushHistory へ移動しキューを空に
pnpm staging:queue flush --force     # 条件未達でも強制（緊急時）
```

flush が出す計画（例）:

```
git fetch origin
git switch -C staging/demo-parity-integ origin/main
git merge --no-ff origin/fe4/gantt-marquee   # gantt-marquee
git merge --no-ff origin/fe5/notif-bell      # notif-bell
git push -u origin staging/demo-parity-integ
#   統合PRに `stagingへ` ラベル → staging.yml が1回デプロイ
bash scripts/verify-live.sh staging 'data-testid="gantt-marquee"' '一括削除' 'data-testid="notif-bell"'
```

> **flush は git/デプロイを自分では実行しない**（共有 repo で破壊的なため）。条件判定・台帳更新・
> **正確なコマンド列の提示**までを行う。実行は人/エージェントが上記コマンドで行う。統合ブランチは
> [04](./04-staging-label-gate.md) の「stagingへ」ラベルゲートに乗せ、staging.yml の liveness ゲート
> （PR本文 `Liveness-Marker:`）で配信 staging バンドルを検証する（05 §2d）。
> フラッシュに含めるマーカーは flush 出力の verify-live 行に全機能ぶん集約される。

反映後 staging = **demo承認済みの全部入り**（demo=staging 一致）。以降は 04 の `確認した` ラベル→main
マージ→自動 prod（一度OKは再確認なし＝[[dub-approval-ship-no-re-review]]）。

## 5. なぜこの形か（フローのルールと対応）

| dub-development-flow のルール | このフローでの担保 |
|---|---|
| 1機能=1エントリ（台帳SoT） | demo/queue とも slug 単位で upsert。重複行を作らない |
| フェーズ排他（demo表とstaging表に同時に居ない） | 承認で queue に入れたら demo は teardown（demo面から消える） |
| 却下はstagingに進めない | 却下は `staging:queue add` しない。demoで再修正→再確認 |
| demo=staging一致（統合ブランチ） | flush が `staging/demo-parity-integ` に承認済みだけを一括マージ |
| 段飛ばししない | demo承認→queue→flush→staging→`確認した`→prod の順のみ |

## 6. オフライン自己テスト（CI 緑の裏取り）

破壊操作なしでロジックだけ検証（`.github/workflows/scripts-selftest.yml` が PR/push で自動実行）:

```bash
pnpm scripts:selftest
# = verify-live / deploy-demo-feature / teardown-demo / staging-queue の --self-test
```

`--self-test` は slugify・マーカー AND grep・キューのフラッシュ条件（5件/経過/手動）・dry-run 不変性を
ネットワーク/wrangler 無しで検証する。

関連: [05-liveness-verification.md](./05-liveness-verification.md) / [04-staging-label-gate.md](./04-staging-label-gate.md) / [`deploy-state/README.md`](../../deploy-state/README.md)
