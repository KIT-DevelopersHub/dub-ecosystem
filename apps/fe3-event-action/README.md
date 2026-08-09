# @dub/fe3-event-action (FE3)

管理SPA の「ホーム > イベント > アクション」中核導線。イベント一覧/詳細/設定・アクション一覧/詳細の4画面と、他FEユニットが使う再利用部品（`EventPicker` / `useEventContext` / `ActionTypeRegistry` / `eventRoutes`）を提供する。データは一切所有せず、`@dub/types` event 契約のみを叩く（gateway 経由）。

- Stack: React 18 + Vite + TanStack Query v5 + Zustand + CSS Modules（`@dub/tokens` CSS変数）+ dnd-kit
- FE2 の FeatureModule (`id="events"`) として登録される（`eventFeatureModule`）。ルーターは FE2 所有・FE3 はセグメント所有（`/events` 木。`tasks*` は FE4 へ委任）。

## コマンド

```
pnpm --filter @dub/fe3-event-action dev         # standalone dev (mock API, hash router)
pnpm --filter @dub/fe3-event-action typecheck
pnpm --filter @dub/fe3-event-action test        # vitest (jsdom)
pnpm --filter @dub/fe3-event-action build
```

## 実装メモ / 前提

- **基盤契約に厳密準拠**: `@dub/types` の実体は `event.DubEvent` / `event.DubAction`（`kind` フィールド）。設計ドラフトの理想名 `Event`/`Action`/`type` ではなく、実装済みパッケージの名前に合わせている。
- **FE1/FE2 は未ビルドのためコントラクト shim を同梱**（`src/contracts/fe1.tsx` `fe2.ts` `navigation.tsx`）。形（IconName/Button/Modal/useToast、FeatureModule/HttpClient/createOptimisticMutation/can/toDisplayableError、navigate/params）は FE3 向け契約。統合時に `@dub/ui` / `@dub/app-shell` / `@dub/api-client` へ差し替える。
- **API は型に対して実装**: `EventApi` インターフェース＋実HTTP実装（`createHttpEventApi`）＋Phase0契約スタブ（`createMockEventApi`、version lock / phase 検証 / archive 不変 / cursor paging を実装）。
- **楽観的UI**: 編集は `createOptimisticMutation`（先に反映→失敗ロールバック＋トースト、409 `EVENT_VERSION_CONFLICT` で rollback＋再取得）。破壊的操作（アーカイブ・closed 遷移）は `ConfirmDialog` 後の非楽観。
- **ActionTypeRegistry**: 未知 kind は `GenericActionPanel` にフォールバック。FE4 が `taskActionPlugin()` を app init で登録（FE6 は P0a 登録なし）。
- **STUB待ち（9-B/C/E 実結線待ち）**: mail(SES)/chat・RT(DO)/Queue は本ユニットでは接続しない（チャットは `/chat?eventId=` への導線のみ）。

## 契約ギャップ（要 event-service への発注）

`@dub/types` event に **action の request/query 型が未定義**（`CreateActionRequest` / `UpdateActionRequest` / `ListActionsQuery` / `ListActionsResponse`）。暫定で `src/api/actionContracts.ts` にローカル定義。event-service が追加したら @dub/types へ移し、ローカル定義を撤去する。

## テスト観点カバレッジ（設計 §7）

pure ロジック（phase/permissions/sortOrder/errorMap/filter/routes/registry）＋ mock API 契約＋ RTL コンポーネント＋ 楽観的mutation を vitest(jsdom) で網羅。#1,#2,#3,#4,#5,#6,#7,#8,#9,#10,#11,#12 に対応（実ブラウザE2E は FE2 シェル統合後）。
