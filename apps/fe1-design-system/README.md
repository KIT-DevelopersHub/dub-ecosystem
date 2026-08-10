# @dub/ui — FE1 Design System

DevHub (Dub) の共通UIコンポーネント。**バックエンドを一切知らない葉パッケージ**（router / data / auth を持たない）。
FE2〜FE7 が `@dub/ui` + `@dub/tokens` を、FE8 が `@dub/tokens/css` のみを、MO1/MO2 が `tokens.json`(DTCG) のみを利用する。

設計正本: `設計_P0a/frontend/FE1-design-system.md` ＋ P0b 凍結サマリ。

## スタック

- React 18 + TypeScript（peerDependency で React 固定・凍結案 1-1-1）
- スタイル = `@dub/tokens` の CSS 変数 + CSS Modules（Tailwind / ランタイム CSS-in-JS 不採用・凍結案 1-1-6）
- ビルド = Vite library mode（JS）+ `tsc` による d.ts 出力（凍結案 1-1-2）
- アイコン = Lucide を `IconName` union で名前解決（凍結案 1-1-7）

## エクスポート

| entry | 内容 |
|---|---|
| `@dub/ui` | 全コンポーネント + 契約型（`src/types.ts`）+ `iconRegistry` |
| `@dub/ui/icons` | Lucide 再エクスポート + `IconName -> Component` レジストリ |

## コンポーネント一覧

| カテゴリ | コンポーネント |
|---|---|
| 基本 | Button / IconButton / Badge / Tag / Avatar / Spinner / Tooltip / Icon |
| Form | Form / FormField / TextField / Textarea / Select / Checkbox / Radio / Switch / DatePicker |
| Table | DataTable / Pagination / LoadMore |
| Overlay | Modal / ConfirmDialog / Drawer / Popover / Toast(ToastProvider + useToast) |
| Layout | ThemeProvider / AppShell / Sidebar / PageHeader / Stack / Grid / Card / Tabs / Divider |
| 状態表示 | EmptyState / ErrorState / SkeletonLoader |
| データ可視化 | Timeline（Gantt: バー + 依存線 + スケール切替。純粋ジオメトリ `timeline-geometry` を同梱） |
| チャット | MessageList（タイムライン: 日付/未読区切り + リアクション + pending/failed + アクション注入） |

## 凍結契約のポイント

- **`testId?` prop を全公開コンポーネントが持ち** DOM の `data-testid` に透過（e2e 規約・凍結案 1-7）。
- **ThemeProvider は controlled**（`theme` prop 必須・内部で localStorage に書かない）。`system` 解決と `dub.ui.theme` 永続は FE2 UiStore 所有（凍結案 1-4-2）。CSS 変数はテーマ値をルート要素にインラインで適用するため単体でも表示可能。
- **Toast 契約はこのパッケージが正**（`kind` 4種・error は自動消滅しない・凍結案 1-4-3）。FE2 は `useToast` を re-export するだけ。
- **Sidebar は router-free**。`renderLink` 注入で FE2 が TanStack Router の Link を差す。`icon` は `IconName`。
- **ErrorState は表示専用**。`DisplayableError`（FE2 api-client の `toDisplayableError` が生成）だけを受け、`@dub/types` / `@dub/errors` を import しない（凍結案 1-4-4）。
- **Pagination = totalCount API 限定 / LoadMore = cursor（自動発火なし）**（凍結案 1-6-3）。DatePicker は v1 ネイティブ `input type=date`（凍結案 1-6-4）。
- **Timeline / MessageList はデータ非依存**。`@dub/types` を import せず、Timeline は行を epoch-ms 数値（`startMs`/`endMs`）で受け、MessageList は本文を描画済み `ReactNode` で受ける。FE4 が自前実装していた raw-SVG Gantt と FE6 の自前チャット CSS を吸収し、契約非破壊で結線できる（バー D&D 用に `pxToDayDelta` / `shiftMsByDays` 等の純関数も公開）。認可依存のアクション（編集/削除・再送/破棄）は `renderActions` / `renderFailedActions` で消費側が注入する。

## スクリプト

```
pnpm --filter @dub/ui typecheck   # tsc --noEmit
pnpm --filter @dub/ui test        # vitest (jsdom + @testing-library/react)
pnpm --filter @dub/ui build       # @dub/tokens build -> vite lib build -> d.ts emit
```

## 受入基準の充足状況

| # | 受入基準 | 状態 |
|---|---|---|
| 1 | `build` で JS + d.ts 緑（tree-shakable・`sideEffects` は CSS のみ） | 満たす |
| 3 | vitest + @testing-library の単体テスト緑（64 件・テストマトリクス網羅） | 満たす |
| 6 | FE2〜FE8 が import する Props 型が設計契約と一致 | 満たす（`src/types.ts`） |
| 7 | 全公開コンポーネントで `testId` が `data-testid` に透過 | 満たす（`Components.test.tsx`） |
| 2/4/5 | Storybook カタログ / axe a11y / light-dark toolbar | **未実装（下記）** |

### 未実装・後続（notes）

- **Storybook（受入 #2/#4/#5）**: カタログ・axe アドオン・テーマ toolbar は本ユニットのボリューム都合で未着手。契約・コンポーネント・単体テスト（アクセシビリティ観点は role/aria/aria-invalid 等で単体テスト側にも織り込み済み）を優先。Storybook 追加は `.storybook/` を本パッケージ内に足すだけで契約に影響しない。公開先は残未決 G'（`storybook.developershub.jp` + Cloudflare Access・infra 追従）。
- **ブランドカラー/フォント初期値（残未決 I）**: `@dub/tokens` 側の初期抽出値。デザイナー確認で値差し替え予定（形状は凍結済みのため契約非破壊）。
