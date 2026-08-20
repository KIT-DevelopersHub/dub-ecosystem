# ダイアログの統一プラン — `@dub/ui` の `Modal` / `ConfirmDialog` へ寄せる

## 結論（PREP）

- **Point:** モーダル（ダイアログ）のコアは `@dub/ui` に既に揃っている（`Modal` / `ConfirmDialog` / `ErrorDialog` / `Drawer`）。ほとんどの画面は既に `Modal` + `footer` prop で正しく組めている。残る不統一は **(a) ブラウザ標準 `window.confirm` の破壊的確認**、**(b) コアを使わずローカルに再実装した確認ダイアログ**、**(c) キャンセルボタンの variant ゆれ（`ghost` vs `secondary`）** の3種。
- **Reason:** 標準 `confirm` は OS 依存の見た目でテーマにも追従せず、統一が最も崩れる。ローカル再実装はコアの styled なアクション行と挙動（async 保留中ローディング等）を取りこぼす。variant ゆれは同じ「キャンセル」ボタンが画面ごとに違う見た目になる。
- **本PRの範囲:** **(a)(b) を実証移行**（下記「本PRで改修済み」）。**(c) と他アプリの寄せ替えは本PRでは触らない**（並行改修中の画面—fe4 ガント / fe5 通知 / fe7 名簿 / fe2 参加届・メンバー / 設定メニュー—との衝突回避のため。担当完了後に別バッチで寄せる）。

## コアコンポーネント（既存・唯一の正）

| 項目 | 値 |
|---|---|
| 置き場所 | `@dub/ui`（`apps/fe1-design-system/src/components/Modal.tsx` + `Modal.module.css`） |
| 公開 | `Modal` / `ConfirmDialog` / `ErrorDialog` / `Drawer`（`index.tsx` から export） |
| `Modal` API | `open` / `onClose` / `title` / `size`(sm/md/lg/full) / `footer`(ReactNode) / `closeOnOverlayClick`(既定true) / `testId` / `children` |
| `ConfirmDialog` API | `open` / `title` / `message`(ReactNode) / `confirmLabel` / `cancelLabel` / `danger` / `onConfirm`(async可・保留中はボタンローディング) / `onCancel` / `testId` |
| `ErrorDialog` API | `open` / `title` / `error`(DisplayableError) / `details?` / `hint?` / `onClose` / `onRetry?` / `testId` — 失敗理由を必ず見せる loud なダイアログ |
| `Drawer` API | `open` / `onClose` / `title?` / `side`(left/right) / `testId` / `children` |
| a11y / 挙動 | `role="dialog"` + `aria-modal` + `aria-label`、フォーカストラップ、初期フォーカス、フォーカス復帰、Esc で閉じる、オーバーレイクリックで閉じる、ref-counted スクロールロック（多重オーバーレイ対応）、`createPortal` で `<body>` 直下描画 |
| 見た目 | `@dub/tokens` 準拠（scrim・surface-raised・radius・shadow-overlay）、`prefers-reduced-motion` 対応の入場アニメ |
| フッターのボタン行 | `Modal` の `footer` prop に @dub/ui `Button` を並べる（`.footer` が flex-end + gap を付与）。②複合 `DialogActions`（`@dub/app-ui`）も可（fe7 で使用中） |
| テスト / 例 | `test/Modal.test.tsx`・`stories/Modal.stories.tsx` |

## 本PRで改修済み（実証移行）

| # | 箇所 | Before | After |
|---|---|---|---|
| A | `apps/fe6-chat/.../ChannelPage.tsx`（メッセージ削除） | `globalThis.confirm("このメッセージを削除しますか？")` | `ConfirmDialog`（`danger` / testId `fe6-timeline-delete-confirm`）。**楽観的削除は維持**（確認を閉じた瞬間に楽観反映→失敗でロールバック+トースト） |
| B | `apps/fe6-chat/.../ChannelSettingsForm.tsx`（アーカイブ） | `globalThis.confirm("…アーカイブしますか？")` | `ConfirmDialog`（testId `fe6-settings-archive-confirm`。解除時は非 danger） |
| C | `apps/fe3-event-action/.../components/ConfirmDialog.tsx` | ローカルに `Modal`+ボタンを手組み（cancel=`ghost`・inline flex） | `@dub/ui` の `ConfirmDialog` へ委譲する薄いラッパー（呼び出し側 `PhaseTransitionControl` / `EventSettingsPage` は無改修・破壊的既定 `danger=true` を保持） |

## 移行候補一覧（本PRでは未改修）

| # | 箇所 | 不統一の種類 | 現状 | 工数感 | 備考 |
|---|---|---|---|---|---|
| 1 | 全アプリのモーダル `footer` | (c) キャンセル variant ゆれ | fe2/@dub/ui=`secondary`、fe4=`ghost`、旧fe3=`ghost` | **小** | 「キャンセル」を1 variant（推奨 `secondary`）に統一する codemod。`ConfirmDialog` は既に `secondary` |
| 2 | `apps/fe7-admin-roster/.../SyncPreviewDialog.tsx` | フッター手組み | `flex-end` の inline なアクション行 | **小** | `Modal.footer` か `DialogActions` に寄せる（fe7担当と衝突注意） |
| 3 | fe4 `TaskCreateModal` / `MyTaskCreateModal` / `TaskDetailDialog` | (c) cancel=`ghost` | `Modal`+`footer`（構造は正） | **小** | variant のみ寄せ替え。ガント並行改修の完了後 |
| 4 | fe5 `NotificationDialog` / fe2 `LinkIdentityDialog`・`MemberFormDialog`・`TeamFormDialog` | 要精査 | `Modal` 使用済み | **小** | 通知タブ / 参加届・メンバー並行改修の完了後に確認して寄せる |

### 対象外（誤爆防止のため記録）

- `apps/fe6-chat/.../ChannelHeader.tsx` / `EmojiPicker.tsx` … `role="dialog"` だが **アンカー付き popover**（メンバー/ピン/絵文字）。モーダルではない別プリミティブ。
- `apps/fe4-task-gantt/.../DateField.tsx` … `createPortal` の **日付ピッカー popover**。モーダルではない。
- `@dub/app-ui` の `DialogActions` … モーダル末尾のボタン行を担う②複合。`Modal` と併用する正しい前例（fe7）。置換対象ではなく推奨形。

## 推奨寄せ替え順序（PREP）

- **Point:** `本PR(A/B/C: 標準confirm撲滅 + fe3ローカル再実装の委譲) → 1(cancel variant統一) → 2(SyncPreview) → 3/4(並行改修完了後の各アプリ)` の順。
- **Reason:** まず「見た目が最も崩れる標準 confirm とローカル再実装」を消し、コアが唯一の正であることを FRONTEND_GUIDE に明記（済）。以降は variant の軽微なゆれを codemod で一掃し、並行改修中の画面は担当完了→origin/main 取り込み後に最後に寄せて大量コンフリクトを避ける。
