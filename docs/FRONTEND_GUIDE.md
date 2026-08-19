# DevHub Frontend Guide

DevHub (Dub) フロントエンド（FE2〜FE8）の設計・実装規約。**UI のブレは UX に直結する**ため、
新しい画面を「迷わず・同じ品質で」作れるように、共通の原則・コンポーネント階層・トークン規約を
ここに一本化する。新規コンポーネント/画面を書く前に必ず読むこと。

## 目次

- [1. 基本原則: すべてをコンポーネント化する](#1-基本原則-すべてをコンポーネント化する)
- [2. コンポーネント階層 (taxonomy)](#2-コンポーネント階層-taxonomy)
- [3. 新しいコンポーネントの足し方](#3-新しいコンポーネントの足し方)
- [4. スタイル規約 (トークン必須 / bespoke 禁止)](#4-スタイル規約-トークン必須--bespoke-禁止)
  - [4.1 余白 (spacing): 要素を近接させ過ぎない（原則・必須）](#41-余白-spacing-要素を近接させ過ぎない原則必須)
- [5. 状態の扱い (loading / empty / error)](#5-状態の扱い-loading--empty--error)
  - [5.1 ローディングとスケルトン UI（原則・必須）](#51-ローディングとスケルトン-ui原則必須)
  - [5.2 Skeleton コンポーネント API](#52-skeleton-コンポーネント-api)
  - [5.3 楽観的 UI（optimistic update）](#53-楽観的-uioptimistic-update)
- [6. アクセシビリティ最低限](#6-アクセシビリティ最低限)
- [7. 命名規約](#7-命名規約)
- [8. チェックリスト](#8-チェックリスト)

---

## 1. 基本原則: すべてをコンポーネント化する

> **コンポーネントでコンポーネントを作り、それを使ったコンポーネントを作る。**
> 少しでも共通化できるものは共通コンポーネントにくくり出し、それを組み合わせて実装する。
> これを React + Vite 開発の基本思想に据える。

積み上げのイメージ:

```
小さなプリミティブ (Button, Input, Select)
  -> それらを compose した複合 (RolePicker = FormField + Select)
    -> さらに compose した画面 (InviteUserDialog = Modal + RolePicker + DialogActions)
```

実装上の定石（React 公式指針 "composition over inheritance" に一致）:

- **再利用は継承 (`class extends`) ではなく合成 (composition)** で行う。
- **振る舞いの共有はカスタム hook (`useXxx`)**。例: 複数入力欄の chip 入力ロジックは
  `useEmailAddressInput`。見た目を持たない「頭のない (headless)」hook にして、複数の
  見た目から使い回す。
- **見た目の差し込みは props / children / slot**。例: `DialogActions` は中身をボタンで
  受け取り、`EmailAddressSelect` は `extra` / `removeIcon` を slot で受ける。
- **DRY**: 同じ inline スタイル片・同じ JSX 断片が 2 箇所に現れたら、共通コンポーネント or
  hook にくくり出す合図。「3 回目で抽出」ではなく「2 回目に気付いたら抽出」を基本にする。

この原則に、以下の階層・スタイル規約すべてが従う。

## 2. コンポーネント階層 (taxonomy)

3 層。上の層は下の層だけに依存し、逆方向の依存を作らない。

| 層 | 名前 | 中身 | データ | 置き場所 |
|---|---|---|---|---|
| ① | **汎用プリミティブ** | Button / Input / Select / Modal / Table / Badge / Toast / Card 等。ドメイン知識ゼロ | 持たない・fetch しない | `@dub/ui` (`apps/fe1-design-system`) |
| ② | **アプリ複合コンポーネント** | `EmailAddressSelect` / `RolePicker` / `DialogActions` / `FormError` 等。①を compose、ドメイン知識入りだが**データは注入**（fetch しない） | props で注入 | **`@dub/app-ui`** (`packages/app-ui`) ※単一アプリ専用の複合は各アプリの `src/components/` から始め、2 つ目のアプリで使う時に `@dub/app-ui` へ昇格 |
| ③ | **画面固有** | ページ / feature。②①を組み、**データ取得 (hooks) と画面レイアウトを所有** | 自分で fetch (TanStack Query 等) | `apps/*/src/**` |

### 各層の憲法

- **① `@dub/ui`**: router / data / auth / ドメインを一切 import しない葉パッケージ。契約型は凍結
  （`src/types.ts`）。ここに「メール」「ロール」などドメイン語彙を持ち込まない。
- **② `@dub/app-ui`**: `@dub/ui` + `@dub/tokens` のみに依存。**データ fetch・router・アプリ
  state を持たない**。ロール一覧・候補アドレス・値・確定関数は**すべて props で受ける**ので、
  FE2 のメールでも FE7 の名簿でも同じ物が使える。ソース直参照で消費（dist を作らない）。
- **③ 画面**: hooks でデータを取り、②に流し込むだけ。**inline スタイルでレイアウトを組み直さない**
  （§4）。「この JSX、他画面でも要るな」と思ったら②へ抽出。

### 現在の②在庫（`@dub/app-ui`）

| コンポーネント | 役割 | 使用画面 |
|---|---|---|
| `EmailAddressSelect` | chip + 候補補完付きの複数メールアドレス入力。`parse`/`candidates` を注入 | FE2 メール作成 (To/Cc/Bcc) |
| `useEmailAddressInput` | 上記の headless 振る舞い hook（chip の確定/削除/追加） | `EmailAddressSelect` 内部・再利用可 |
| `RolePicker` | ロール一覧 → ラベル付き Select。`includeNone`/`placeholder` 対応 | FE7 招待・ロール付与 |
| `DialogActions` | ダイアログ末尾のボタン行（右寄せ等） | FE7 招待・付与・アドレス発行 |
| `FormError` | `role="alert"` のフォームエラー段落（空なら何も描画しない） | FE7 招待・付与・アドレス発行 |

## 3. 新しいコンポーネントの足し方

**②のアプリ複合を足す手順**（例が増える前提でここを定石化する）:

1. **①で足りるか確認**: 単なる Button/Input の並びなら②を作らず画面で直接①を使う。
   「ドメイン語彙が入る」or「同じ組み合わせを 2 画面で使う」なら②にする。
2. **配置**: 2 つ以上のアプリで使う（見込み含む）なら `packages/app-ui/src/components/`。
   1 アプリ限定なら `apps/<app>/src/components/` に置き、2 つ目で必要になったら②へ昇格。
3. **ファイルを作る**:
   - `packages/app-ui/src/components/<Name>.tsx`（＋必要なら `<Name>.module.css`）
   - 振る舞いが再利用可能なら `packages/app-ui/src/hooks/use<Name>.ts` に headless hook を分離
   - `packages/app-ui/src/index.ts` から `export`（コンポーネント + 型）
4. **API 設計**: **データは注入**（`roles` / `candidates` / `value` / `onChange`）。fetch や
   router を中に入れない。見た目差し込みは `children` / slot props（`extra` 等）。`testId?` を
   受けて DOM の `data-testid` に透過する（e2e 規約）。
5. **単体テスト**: `packages/app-ui/test/<Name>.test.tsx`（jsdom + @testing-library）。
6. **緑を確認**: `pnpm --filter @dub/app-ui typecheck && pnpm --filter @dub/app-ui test`。
7. **画面を置換**: 既存画面の重複 JSX を新②に差し替え、**挙動非破壊**（testId / DOM 構造 /
   キーボード操作を保つ）で移行。該当アプリの test + typecheck を緑に戻す。

消費側（アプリ）への配線は既に済んでいる（`tsconfig.base.json` の `paths`、各アプリの
`vite`/`vitest` は `vite-tsconfig-paths` 経由で解決、FE7 は tsconfig `paths` に明示追加済み）。
新しい②を足すだけなら配線変更は不要。

## 4. スタイル規約 (トークン必須 / bespoke 禁止)

- **スタイルは `@dub/tokens` の CSS 変数のみ**。生値（hex・px・rgba）を直書きしない。
  - 色 = `var(--dub-color-*)` / 余白 = `var(--dub-space-*)` / 角丸 = `var(--dub-radius-*)` /
    影 = `var(--dub-shadow-*)` / タイポ = `var(--dub-font-*)` / z = `var(--dub-z-index-*)` /
    モーション = `var(--dub-motion-*)`。
  - **存在しないトークン名を書かない**。`--dub-color-fg-muted` は無い（正: `--dub-color-text-muted`）。
    フォールバック `var(--x, #57606a)` に生 hex を隠すと、テーマ切替で崩れる。トークン名は
    `packages/tokens/src/index.ts` が唯一の正。
- **CSS の書き方の優先順位**:
  1. **①/②のコンポーネントを使う**（最優先）。ボタン・入力・カード・ダイアログは自作しない。
  2. どうしても素の要素にスタイルが要るなら **CSS Modules (`*.module.css`)**。バリアントは
     `data-*` 属性セレクタで分岐（`@dub/ui` の `Button.module.css` 参照）。
  3. アプリ全体のベース（reset・タイポ・shell chrome）は各アプリの `styles/global.css` に
     `.<app>-*` プレフィックスのクラスで（FE2 `global.css` 参照）。
- **inline `style={{}}` は原則禁止**。許容は「実行時に決まる動的値のみ」
  （例: データ由来の色 `background: l.color`、座標 `right: offset*30`）。**静的な見た目を
  inline で組まない**——それは CSS Modules か②に出す。
- **Tailwind / ランタイム CSS-in-JS は不採用**（凍結）。
- **ライト/ダーク両対応**: 色は必ずトークン経由。生 hex を置くと片テーマで破綻する。
- **排他選択（segment / tab strip）UI はコアで組む**: 「同格の少数択一を1つ選ぶ」UI
  （ビュー切替・粒度・スコープ・モード切替など）は `@dub/ui` の **`SegmentedControl`**
  を使う。`role="tablist"` + アクティブ class の手組みや、スライドするインジケータの再実装を
  しない（a11y・`prefers-reduced-motion`・折返し追従がブレる）。画面の主セクション切替（下線
  タブ）は既存 `Tabs`。既存の手組み箇所と寄せ替え順は
  [選択UIの統一プラン](./segmented-control-unification.md) を参照。
- **並べ替え（ドラッグ&ドロップ）UI はコアで組む**: リストの手動並べ替えは `@dub/ui` の
  **`SortableList`** を使う。`@dnd-kit` を各画面で直接組んで「浮遊オーバーレイ・周辺行の
  reflow（場所を空ける）・ドロップのコミット・キーボード操作/aria」を再実装しない
  （体験と a11y がブレる）。コンポーネントが「掴んだ行が浮くクローン＋隣接行が滑らかにずれて
  ギャップを開ける＋`prefers-reduced-motion` 尊重＋Space/矢印でのキーボード並べ替え＋
  ライブリージョン通知」を一括で提供する。`items`／`getItemId`／`renderItem(item, {dragHandleProps})`／
  `renderOverlay?`／`onReorder(event)` を渡し、**並び順の確定ロジック（フラットな `arrayMove`か、
  ツリーの兄弟内移動か）は呼び出し側が `onReorder` で持つ**（例: `apps/fe4-task-gantt` のガントは
  兄弟スコープに写像して既存の順序 API に渡す）。ドラッグの見た目/操作は変えず、確定だけ差し替える。

### 4.1 余白 (spacing): 要素を近接させ過ぎない（原則・必須）

> **【デザインシステム原則】要素同士は十分な余白を取る。隣接する操作要素・セクションを密着させない。**
> 余白は必ず `@dub/tokens` の spacing スケール（`--dub-space-*` / `Stack`・`Grid` の `gap`）で与え、
> 生の `px`・`margin: 0` の詰め込み・余白ゼロの縦積みをしない。

**なぜ**: 要素が近すぎると「どれとどれが1グループか」が読めず、押し間違い・視認性低下を招く。
実例: 通知一覧のフィルタで、タブ行のすぐ下に「未読のみ」トグルが余白ゼロで貼り付き、別操作なのに
1つの塊に見えていた（本ガイドの発端）。余白は**意味の区切り**であり、装飾ではない。

**ルール**:

1. **縦/横に積む複数要素の間隔は `Stack`/`Grid` の `gap`（トークン値）で与える。**
   余白ゼロの `<div>` 直積みにしない。`gap` の目安:
   - **隣接する操作要素**（タブ↔トグル、入力↔ボタン、フィルタ群）= **最低 `gap={3}`（12px＝`--dub-space-3`）**。
   - **セクション間**（ヘッダ↔本文、フィルタ↔一覧、カード群↔次ブロック）= **`gap={4}`〜`gap={6}`（16〜24px）**。
   - 密なメタ情報（バッジ↔時刻など、意味的に1グループ）だけ `gap={1}`〜`gap={2}`（4〜8px）に寄せてよい。
2. **素の要素に余白が要るときも `@dub/tokens` の CSS 変数で**（`margin`/`padding`/`gap` = `var(--dub-space-*)`）。
   生 `px` や `margin: 0` の押し込みで詰めない（§4 の「トークン必須」に従う）。
3. **1画面をベタ積みしない**: レイアウトの縦積みは基本 `Stack gap=...`、格子は `Grid gap=...` に載せる。
   inline `style` で `marginTop: 8` などの静的余白を書かない（§4：静的スタイルは inline 禁止）。
4. **近接（proximity）で意味を作る**: 関係が近い要素は小さめ、別グループへ移るところは大きめ、と
   `gap` で強弱を付ける（すべて同じ間隔にしない）。ただし**最小でも隣接操作要素は `gap={3}` を下回らない**。

```tsx
// 悪い: 余白ゼロで縦積み（タブとトグルが密着＝別操作なのに1塊に見える）
<div>
  <Tabs ... />
  <Switch label="Unread only" ... />
</div>

// 良い: token gap で区切る（隣接操作要素は最低 gap={3}=12px）
<Stack gap={3}>
  <Tabs ... />
  <Switch label="Unread only" ... />
</Stack>
```

## 5. 状態の扱い (loading / empty / error)

データを表示する画面は 3 状態を必ず用意する（①のコンポーネントを使う）:

- **loading**: **スケルトン**（`SkeletonList` / `SkeletonTable` / `SkeletonCard` / `Skeleton` / `SkeletonLoader`）。§5.1 参照。
- **empty**: `EmptyState`（0 件時。「データがありません」を各自で組まない）。
- **error**: `ErrorState`（`DisplayableError` を渡す。retry があれば `onRetry`）。

フォームのエラーは:

- **フィールド単位** = `FormField` の `error` prop（`aria-invalid` が付く）。
- **フォーム全体** = `@dub/app-ui` の `FormError`（`role="alert"`）。

### 5.1 ローディングとスケルトン UI（原則・必須）

> **【デザインシステム原則】読み込み中は必ずスケルトン UI を出す。素の空表示を禁止する。**
> データ取得を伴う UI は、データ到着前に**必ずスケルトン**（実際に出る要素の形を模したプレースホルダ）を描く。
> 「空データ (0 件)」と「読み込み中」は**別物**として必ず描き分ける。

**なぜ**: ローディング中に何も出さない／プレーンな空表示のままだと、ユーザーは「**データが無い**のか
**読み込み中**なのか判別できない」。空表示は「0 件」だけを意味させ、読み込み中はスケルトンで「これから何か出る」
ことを形で示す。これで体感速度も上がる（レイアウトが先に埋まり、ガタつき＝CLS が減る）。

**ルール**:

1. **リスト / カード / テーブル / 詳細パネルなど、データ取得を伴う UI は初期状態でスケルトンを出す。**
   `isLoading` / `isPending` の分岐で**最初に**スケルトンを返す（`empty` / `error` より先に判定する）。
2. **素の空表示・プレーンな「読み込み中…」テキスト・レイアウトの無い `Spinner` 単体は不可**
   （リスト/テーブル/カードでは）。スケルトンは**実際のレイアウトの形**に寄せる（行数・カラム数・カードの
   メディア枠を近似する）。
3. **空データは明示的な `EmptyState`** で表す。**読み込み中に `EmptyState` へ落とさない**
   （「データがありません」を一瞬見せない）。この 2 つを必ず描き分ける。
4. **`Spinner` を使ってよいのは**、レイアウトを占有しない小さな箇所（ボタン内・トグル・インライン処理中）だけ。
   一覧そのものの初期ロードには使わない。
5. スケルトンは `role="status" aria-label="読み込み中"` を**1 つ**持つ（合成コンポーネントが自動で付ける）。
   個々のブロックは `aria-hidden`。

分岐の定石（**loading を最優先で判定**する）:

```tsx
{query.isLoading ? (
  <SkeletonList rows={5} />          // 必ずスケルトン（素の空表示にしない）
) : query.isError ? (
  <ErrorState error={displayError(query.error)} onRetry={() => query.refetch()} />
) : items.length === 0 ? (
  <EmptyState title="イベントがありません" />   // 0 件のときだけ
) : (
  <div className={styles.grid}>{items.map(/* ... */)}</div>
)}
```

### 5.2 Skeleton コンポーネント API

`@dub/ui`（①）が提供する。ドメイン知識ゼロ・トークンのみ・ライト/ダーク両対応・`prefers-reduced-motion`
尊重（アニメを止めて静的プレースホルダにフォールバック）。

| 物 | 用途 | 主な props |
|---|---|---|
| `Skeleton` | 単一プレースホルダ（自分で並べる用）。**装飾なので `aria-hidden`** | `variant`=`text`\|`circle`\|`rect` / `width` / `height`（number=px）/ `radius` / `animation`=`shimmer`\|`pulse`\|`none` |
| `SkeletonList` | 一覧のロード中。`role="status"` を内包 | `rows`(=3) / `avatar`(先頭に丸) / `animation` |
| `SkeletonTable` | テーブルのロード中。ヘッダ＋セル格子 | `rows`(=5) / `columns`(=4) / `header`(=true) |
| `SkeletonCard` | カードのロード中。メディア枠＋タイトル＋本文行 | `media`(先頭に矩形) / `lines`(=2) |
| `SkeletonLoader` | 汎用の n 行スケルトン（既存・後方互換） | `lines`(=3) / `width` |

使い分け: **一覧＝`SkeletonList`** / **表＝`SkeletonTable`** / **カードグリッド＝`SkeletonCard` を実カード枚数ぶん** /
それ以外の任意形状は `Skeleton` を自分で compose。合成物（List/Table/Card）は `role="status"` を持つので、
1 画面で複数出す時は**代表 1 つに testId** を付ける程度でよい。

### 5.3 楽観的 UI（optimistic update）

> **すべてのミューテーションは楽観的 UI にする（例外なし）**。操作した瞬間に UI へ反映 → 裏で確定 →
> 失敗したときだけロールバック。毎回サーバ往復のローディングを待たせない。原則の背景は memory
> `[[optimistic-ui-principle]]`。

> **【対象＝全ミューテーション・例外なし】作成 / 更新（インライン編集）/ **削除** / トグル / 並べ替え（D&D）/
> 紐付け（親子・依存・リンク）/ ステータス変更 —— これら書き込み操作はすべて楽観的 UI 必須。**
> とくに **削除（delete）も楽観的にする**：クリック（＝確認ダイアログを閉じた）瞬間に一覧から消す
> （物理削除＝即時に行を除去 / 論理削除・トゥームストーン＝即時に「削除されました」表示に差し替え）→ 裏で
> DELETE を確定 → **失敗時のみ元に戻す＋エラートースト**。「削除を押したのに残っている／消えるまで待つ」を
> 二度と出さない。

> **【必須・3 点セット】** どのミューテーションも「①楽観的 UI ＋ ②（必要なら）成功トースト ＋
> ③エラートースト＋ロールバック」をセットで実装する。①か③が欠けた書き込み UI は不可（レビューで差し戻す）。

- **やり方（共通）**: 現在値を snapshot → UI を**先に**新値へ更新して即描画 → サーバ確定 → 成功したら
  reconcile（サーバ正で整合）→ **失敗したら snapshot に**ロールバック**＋エラートースト**（握り潰さない）。
  実装は各 feature の楽観ランナーに寄せる：
  - TanStack Query 系（fe4/fe7 等）: `onMutate` で `qc.setQueryData` を先に更新 → `onError` でロールバック →
    `onSettled` で `invalidate`/refetch。トースト＋エラー文言は共通フックへ（fe4 `useWriteFeedback()`
    = `success(msg?)` / `failure(err, fallback?)`）。
  - ローカルストア系（fe6 チャット等）: `runOptimistic(box, { apply, mutate, reconcile, rollback })`
    （`store/optimistic.ts`）。`apply` が即時反映、`reconcile` がサーバ正、`rollback` は既定でスナップショット復元。
- **delete の型（必ずこの形）**: `apply` で行を除去（or トゥームストーン化）→ `mutate` で DELETE →
  `reconcile` でサーバの確定結果に整合（例: サーバが返す mode に合わせて hard=除去 / tombstone=差し替え）→
  失敗時は既定ロールバックで**行を復活**させ、呼び出し側でエラートースト。実例: fe6 chat
  `useChannelView.deleteMessage`（`runOptimistic` + 予測モードで即時反映、RT エコー/レスポンスで reconcile）。
- **確認ダイアログと楽観的 UI は両立する**: 破壊的操作は確認ダイアログを出してよいが、それは**楽観的 UI を
  やらない理由にはならない**。ユーザーが確認した後の状態変更は楽観的に反映する（confirm → 即時反映 →
  裏で確定 → 失敗でロールバック）。
- **ローディングとの関係**: 楽観的更新できた操作では、その部分に**スピナー/スケルトンを出さない**
  （既に反映済みだから）。スケルトンは「まだ手元に無いデータの**初期取得**」に使い、楽観的 UI は
  「既にあるデータの**変更**」に使う——役割を混同しない。
- **成功トーストの調整**: バー移動・削除など**視覚的変化そのものがフィードバックになる操作**は成功トーストを
  省いてよい（連打でトーストが溢れる／変化が自明なため）。ただし**失敗時のエラートースト＋ロールバックは
  省略不可**。
- **唯一の但し書き（楽観化しない例外ではない）**: 外部的に不可逆で結果をクライアントで予測できない操作
  （実決済の確定など）に限り、実ローディング表示を併用してよい。それでも③（失敗トースト＋整合）は必須。
  上記の全ミューテーション（作成/更新/削除/トグル/並べ替え/紐付け/ステータス変更）は**この但し書きに該当しない**
  ＝必ず楽観的にする。

## 6. アクセシビリティ最低限

- インタラクティブ要素は `button` / `a` / ネイティブ input を使う（`div onClick` を避ける）。
  やむを得ず `all: unset` した `button` を使うときも要素は `button` のまま。
- ラベル: アイコンのみのボタンは `aria-label`。入力は `FormField` の `label`+`htmlFor` で結ぶ。
- フォーカス: `:focus-visible` のアウトラインを潰さない（global.css が既定を持つ）。
- 状態: 選択中は `aria-current` / 展開は `aria-expanded` / エラーは `role="alert"`。
- コントラスト: テキストは `--dub-color-text-*`、薄字でも `text-muted` 止まり（さらに薄くしない）。

### 6.1 テキスト入力の Enter は IME 安全に（必須）

日本語などの IME で変換候補を確定する Enter（変換確定 Enter）は、`keydown` が
`isComposing === true`（旧ブラウザは `keyCode === 229`）の状態で発火する。**Enter で送信/確定する
テキスト入力を自作するときは、必ず `@dub/ui` の共有プリミティブを通す**。これを踏まないと、
チャット送信欄などで「変換を確定しただけ」なのに送信されてしまう。

- 送信専用の欄（Enter で送信 / Shift+Enter で改行）は `useEnterToSubmit(onSubmit)` を使い、
  返ってくる `{ onKeyDown, onCompositionStart, onCompositionEnd }` を入力要素にそのまま展開する。
- `keydown` で送信以外の処理も分岐する複雑な欄（メンション候補・整形ショートカット等）は、
  ハンドラ先頭で `if (isImeComposing(e)) return;` を必ず入れる（＋堅牢性のため composition ref も併用）。
- ネイティブ `<form>` の Enter 送信（`<Form onSubmit>`）はブラウザが変換確定 Enter を送信しないので追加対応は不要。

```tsx
import { useEnterToSubmit } from "@dub/ui";
const enter = useEnterToSubmit(send);        // Enter=送信 / Shift+Enter=改行 / 変換確定 Enter=何もしない
<textarea value={text} onChange={...} {...enter} />
```

## 7. 命名規約

- コンポーネント = PascalCase（`EmailAddressSelect`）。hook = `useCamelCase`（`useEmailAddressInput`）。
- CSS Modules クラス = camelCase（`.chipRemove`）。バリアントは `data-*` 属性で。
- `testId` は `fe<n>-<feature>-<element>`（例 `fe7-invite-role`）。既存 testId は e2e/単体が
  参照するので、リファクタで**変えない**。
- 1 ファイル 1 コンポーネント（＋その CSS Module）。フォルダは 1 階層 7 ファイルまで
  （memory `[[obsidian-max-7-files-per-folder]]` と同趣旨、超えたら分割）。

## 8. チェックリスト

新しい画面/コンポーネントを出す前に:

- [ ] ①/②で組んだか（ボタン・入力・ダイアログを自作していないか）
- [ ] 同じ JSX/スタイルの重複を②か hook に抜き出したか
- [ ] 生値（hex/px/rgba）を直書きしていないか（トークンのみか）
- [ ] 静的スタイルを inline `style` で書いていないか（CSS Modules / ②か）
- [ ] **要素を近接させ過ぎていないか**（隣接する操作要素は最低 `gap={3}`＝`--dub-space-3`、セクション間は
      `gap={4}`〜`gap={6}`）。余白ゼロの `<div>` 直積みにせず、`Stack`/`Grid` の `gap`（トークン値）で
      与えているか（§4.1）
- [ ] loading / empty / error の 3 状態を用意したか
- [ ] **ローディングがスケルトンになっているか**（素の空表示・プレーンな「読み込み中…」・一覧の `Spinner`
      単体は不可）。**loading を最優先で判定**し、読み込み中に `EmptyState` へ落としていないか（§5.1）
- [ ] **空データを `EmptyState` で明示**し、「読み込み中」と描き分けているか（§5.1）
- [ ] **すべてのミューテーション**（作成/更新/**削除**/トグル/並べ替え/紐付け/ステータス変更）を**楽観的 UI**に
      したか（例外なし・先に反映 → 失敗でロールバック＋エラートースト）。**特に delete も即時反映**したか（§5.3）
- [ ] `aria-label` / `label`+`htmlFor` / フォーカスリングを満たすか
- [ ] Enter で送信/確定する自作テキスト入力は `useEnterToSubmit` / `isImeComposing` を通したか（§6.1・変換確定 Enter で誤送信しない）
- [ ] `testId` を既存から変えていないか
- [ ] `typecheck` 緑 / 単体テスト緑（重い実ブラウザ E2E は別工程）
