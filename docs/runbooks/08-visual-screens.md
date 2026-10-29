# 08 — 画面ビジュアル回帰（fe2 app screens・Phase 1 = 警告のみ）

> 結論: fe2 の主要画面を **demo ビルド（`VITE_DEMO=1`・バックエンド不要）** で撮り、コミット済み
> ベースラインと pixel diff する。**今は警告のみ**（PR をブロックしない）。差分は PR コメント1件・
> ジョブサマリ・artifact で見える。$0・self-hosted（Playwright `toHaveScreenshot`）・SaaS なし。
> 部品単位の `@dub/ui` Storybook 回帰（`visual-regression.yml` / `apps/fe1-design-system/visual/`）の画面版。

## 1. 何を見ているか

| 画面 | 経路 | desktop 1440×900 | mobile 390×844 |
|---|---|---|---|
| home | `/` ダッシュボード | ○ | ○ |
| launcher-open | `/` でアプリランチャー（9ドット）を開いた状態 | ○ | |
| mail-inbox | `/mail` 受信トレイ | ○ | ○ |
| mail-thread | `/mail` で「スポンサー契約書の送付」を開いた状態 | ○ | |
| chat | `/chat`（fe6・#general） | ○ | |
| tasks-my | `/me/tasks`（fe4 マイタスク） | ○ | ○ |
| calendar | `/calendar` 週表示 | ○ | |
| notifications | `/notifications`（fe5） | ○ | |

コード: `apps/fe2-app-shell/visual/`（`screens.spec.ts` に画面を1行足せば増える。mobile にも出すなら `mobile: true`）。

### 決定性（フレーク対策）

- **時刻固定**: `page.clock.setFixedTime(2026-06-15 10:00 JST)`。demo-seed は `Date.now()` 起点なので相対日付・カウントダウン・カレンダーの「今日」/現在線が固定される。
- ロケール `ja-JP` / TZ `Asia/Tokyo` / light / `reducedMotion: reduce` / 固定ビューポート。
- アニメ・トランジション・キャレットを CSS で殺し、`animations: "disabled"`。
- スケルトン（`[data-testid*="skeleton"]` / `.dub-skeleton-shimmer`）が消えるまで待つ + `document.fonts.ready` + 2 フレーム。
- マスク: chat のリアルタイム接続バナー（demo はソケットが無く文言が揺れる）。アバター色は名前ハッシュで決定的なのでマスク不要。
- フォント: CI は fe1 と **同じ pinned イメージ** `mcr.microsoft.com/playwright:v1.62.1-jammy` で走り `*-linux.png` と比較。ローカル macOS は `*-darwin.png`（別セット・共存）。
- 許容: `maxDiffPixels: 150` / `threshold: 0.2`（ローカル実測: 同一ビルドの連続実行で差分 0px）。

## 2. PR コメントの読み方

対象パス（`apps/fe2-app-shell/**`, `apps/fe1-design-system/**`, `apps/fe3〜fe7/**`, `packages/tokens/**`, `packages/app-ui/**`）を触った PR で
**Visual Screens (warning-only)** が走り、bot が1件だけコメントを作る/更新する（同一リポジトリの PR のみ）。

| 表示 | 意味 / やること |
|---|---|
| ✅ 差分なし | 何もしない（以前のコメントがあれば上書きされる。差分も既存コメントも無ければ投稿しない） |
| ⚠️ N 枚に差分（表） | artifact **`visual-screens-diff`** をDL → `.report/index.html` で expected / actual / diff を見る。意図通りならベースライン更新（§3）、意図外ならリグレッション |
| ベースライン無し（新規画面） | 新しく足した画面。§3 で seed |
| エラー | 画面が出なかった（testid 変更・ルート変更等）。ログ参照 |
| 🌱 Linux ベースラインがまだありません | 初回。生成画像は artifact `visual-screens-seed`。§3 を実行 |

ジョブ自体は差分があっても緑（`::warning::` 注釈とジョブサマリに同じ内容が出る）。

## 3. ベースラインの更新 / 初回 seed

- **Linux（CI が比較する正）**: Actions → **Visual Screens Baselines (seed/update)** → `Run workflow`、`ref` に自分のブランチ名。
  pinned イメージ内で `*-linux.png` を再生成してそのブランチにコミットする（`[skip ci]`）。その後 PR を更新するか
  **Visual Screens** を再実行すると比較が有効になる。
- `workflow_dispatch` は **main にあるワークフローしか起動できない**。main 未導入の段階（このワークフローを足した PR 自体など）は、
  比較ワークフローの初回実行が出す artifact `visual-screens-seed`（pinned イメージ内で生成済み）を
  `apps/fe2-app-shell/visual/__screenshots__/` に展開してコミットすれば同じ結果になる（初期ベースラインはこの方法で seed 済み）。
- Docker があればローカルでも同じことができる:

  ```bash
  docker run --rm -v "$PWD":/w -w /w mcr.microsoft.com/playwright:v1.62.1-jammy \
    bash -c "corepack enable && pnpm install --frozen-lockfile && \
             pnpm --filter @dub/fe2-app-shell visual:build && pnpm --filter @dub/fe2-app-shell visual:update"
  ```

- **macOS（ローカル確認用）**:

  ```bash
  pnpm --filter @dub/fe2-app-shell visual:build    # 依存ビルド + VITE_DEMO=1 vite build
  pnpm --filter @dub/fe2-app-shell visual          # 比較（VISUAL_PORT で preview ポート変更、既定 5419）
  pnpm --filter @dub/fe2-app-shell visual:update   # *-darwin.png 更新
  pnpm --filter @dub/fe2-app-shell visual:report   # HTML レポート
  ```

`@playwright/test` を上げたら、両ワークフローのイメージタグを同じ版に上げてベースラインを撮り直す（fe1 と同じ運用）。

## 4. 今後: 必須チェック化の計画

1. **Phase 1（今）**: 警告のみ。約2週間、誤検知（意図しない差分・フレーク）の件数を PR コメントで観察する。
2. 誤検知がほぼ無ければ **Phase 2**: `Run screen visual regression` の `continue-on-error` を外し、
   ブランチ保護の必須チェックに `fe2 screens · toHaveScreenshot` を追加（ブランチ保護の変更はオーナー判断）。
3. 誤検知が出た画面は、マスク追加 / 待ち条件の強化 / 一時的に対象から外す、で潰してから必須化する。
