# 選択UIの統一プラン — `SegmentedControl` へ寄せる

## 結論（PREP）

- **Point:** 手組みの「排他選択（segment / tab strip）UI」は主に **fe4-task-gantt に3箇所** と **fe7 に1箇所** ある。これらを新設した共通プリミティブ `@dub/ui` の **`SegmentedControl`** に寄せる。
- **Reason:** 同じ `role="tablist"` + アクティブ class の定石が各所でコピーされており、スライドのイージング・a11y・`prefers-reduced-motion`・折返し追従（ResizeObserver）が実装ごとにブレる。1つのコアに集約すれば見た目と挙動が揃い、重複が消える。
- **本PRの範囲:** コア新設 + **fe7 ロール管理の1箇所だけ**を実証移行済み。**下記の他候補は本PRでは改修しない**（設計変更はレビューに戻す方針）。

## コアコンポーネント（本PRで新設済み）

| 項目 | 値 |
|---|---|
| 置き場所 | `@dub/ui`（`apps/fe1-design-system/src/components/SegmentedControl.tsx` + `.module.css`） |
| 型 | `SegmentedControlProps<V>` / `SegmentedOption<V>`（`src/types.ts`、`index.tsx` から export） |
| API | `options`（value / label / icon / disabled / testId / controls）・`value`+`onChange`（制御）・`defaultValue`（未制御は先頭自動選択）・`caption` / `captionTestId`・`size`（sm/md/lg）・`aria-label` |
| a11y | `role="tablist"` / `role="tab"` + `aria-selected`、roving tabindex + 矢印/Home/Endキー、`controls` 指定時のみ `aria-controls`+`aria-expanded` |
| モーション | スライドするインジケータ内蔵（実測 geometry のみ inline、見た目/イージングは CSS Module）。折返しは ResizeObserver 追従。`prefers-reduced-motion` 対応 |
| テスト / 例 | `test/SegmentedControl.test.tsx`（10 green）・`stories/SegmentedControl.stories.tsx` |

## 移行候補一覧（本PRでは未改修）

| # | 箇所 | 選ぶ対象 | 現状の実装 | 工数感 | 備考 |
|---|---|---|---|---|---|
| 1 | `apps/fe4-task-gantt/src/components/ViewSwitcher.tsx` | リスト / ボード / ガント | `role="tablist"` + `switcherBtnActive` class | **小** | 静的3択の教科書ケース。API を固める最初の一手 |
| 2 | `apps/fe4-task-gantt/src/components/GanttView.tsx`（`tlSeg` 付近） | 月 / 週 / 日 | `role="tablist"` + `tlSegBtnOn` class | **小** | 大きいファイル内の自己完結ブロック。抽出の検証に良い |
| 3 | `apps/fe4-task-gantt/src/components/TeamViewSwitcher.tsx` | 全体 / 各チーム | `role="tablist"` + `teamChipOn` class | **中** | 動的な選択肢 + チーム色ドット + `disabled`。ドットは `label`(ReactNode) で表現可 |
| 4 | `apps/fe7-admin-roster/src/components/ScopePicker.tsx` | 組織全体 / イベント単位 | `input type="radio"` × 2 + 従属 `<Select>` | **中** | 排他選択部分だけコア化。従属 Select は消費側に残す（ラジオ意味論の非タブ例の検証） |

### 対象外（誤爆防止のため記録）

- `apps/fe4-task-gantt/.../TaskFilterBar.tsx` … ステータスは **複数選択**（`aria-pressed` トグル）。segment ではない。
- `apps/fe3-event-action/.../EventListPage.tsx` / `ActionBoard.tsx` … フェーズ/種別は native `<select>`。ドロップダウンのまま。
- `apps/fe5-notification-inbox/.../NotificationFilterBar.tsx` / `apps/fe2-app-shell/.../MailFolderTabs.tsx` … **既に共通 `Tabs` を使用**（良い前例）。
- `apps/fe2-app-shell/.../driveshare/DriveShareScreen.tsx` … 無制限リストの単一アクティブ行（listbox 的）。固定 segment 集合ではない。

## 推奨コア化順序（PREP）

- **Point:** `1 ViewSwitcher → 2 GanttView ズーム → 3 TeamViewSwitcher → 4 ScopePicker` の順。
- **Reason:** 1・2 は同一 app・同一 CSS Module（`switcher*` / `tlSeg*` / `teamChip*`）に同じ定石が3コピーあり、まず 1 で API を確定 → 2 で大ファイルからの抽出を検証 → 3 で「動的選択肢 + 装飾 + disabled」を API に通す → 4 で「ラジオ意味論 + 従属フィールド」という非タブ例までカバーできる。
- **Point:** この4つで真に手組みの排他選択は一掃され、残りは正しく `<select>` / 複数トグル / 既存 `Tabs` に収まる。

## タブ系との棲み分け（`Tabs` vs `SegmentedControl`）

- **`Tabs`（既存）:** 下線タブ。画面の主セクション切替（ページ内の大分類）向け。
- **`SegmentedControl`（新）:** 囲みのある pill 型セグメント。ビュー切替 / 粒度 / スコープなど「同格の少数択一を1つ選ぶ」向け。スライドするインジケータが選択位置を明示する。
