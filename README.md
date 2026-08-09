# dub-ecosystem

DevHub (Dub) エコシステムの pnpm + turbo モノレポ。本コミットは **P0b で凍結された「基盤契約パッケージ」** の実装（コスト影響ゼロの型・契約層のみ）。サービス実装（dub-gateway 等の中身）は次波スコープ外。

正本ドキュメント: `Home/experience/Other/Projects/DevHubエコシステム/設計_P0b/_P0b凍結サマリ_2026-08-09.md` および `設計_P0a/`。

## パッケージ

| パッケージ | 役割 | 依存 |
|---|---|---|
| `@dub/types` | 全サービス間 HTTP 契約型の単一真実。18名前空間+common・型専用（宣言済み定数のみ runtime）。`PERMISSION_CATALOG`(23キー closed)・状態機械enum・`Paginated`・`Versioned`・`SYNC_AUDIT_ACTIONS` 等 | なし（leaf） |
| `@dub/errors` | 統一 `DubError`・`ErrorResponse` wire 型・SCREAMING_SNAKE コード・`fromResponse` 復元一本化・Hono `onError` | なし（runtime依存ゼロ・hono type-only peer） |
| `@dub/observability` | canonical `x-dub-*` ヘッダ定数の正本・`redactSecrets`(監査 sanitizer 用)・構造化ログ形 | なし（leaf） |
| `@dub/http` | Service Binding クライアント・`x-dub-*` 伝播・リトライ/タイムアウト・上流エラー復元・`dubContext` | errors, observability, (types) |
| `@dub/db` | 名前空間スコープ D1 クライアント・forward-only migration+台帳+lint・`NAMESPACES`(16)・`newId`/`nowIso` | errors |
| `@dub/events` | Queue イベントカタログ（canonical エンベロープ・契約12本+DLQ・`SUBSCRIPTIONS`）・`publishAudit`/`publishWebhookEvent` | types, errors, observability |
| `@dub/auth-client` | `mode:"trustedHeader"` 既定の認証文脈取得＋identity `/authz/check` ラッパ（TTLキャッシュ・dangerous常時同期・fail-closed） | types, errors, http, hono |
| `@dub/tokens` | デザイントークン3形態配布（TS定数 / `@dub/tokens/css` / DTCG `tokens.json`）・light/dark | なし（leaf） |

> タスク指定の基盤5パッケージ（types/db/events/auth-client/tokens）に加え、それらが型チェック・テストを緑にするために必須の leaf 契約パッケージ **errors / observability / http** も同時実装した（いずれもコスト影響ゼロの契約層）。

## 開発

```bash
pnpm install
pnpm typecheck   # tsc --noEmit（全パッケージ・path alias で src 参照）
pnpm test        # vitest run（全パッケージ）
pnpm build       # turbo run build（tsup で dist 出力・依存順）
```

`packages/tokens/tokens.json` は TS 定数から生成する（`pnpm --filter @dub/tokens build && node packages/tokens/scripts/gen-tokens-json.mjs`）。テストが on-disk と `buildDtcgDocument()` の一致を検証するため 3 配布形態はドリフトしない。

## P0b 凍結の反映メモ（実装時に確定した点）

- **相関ID（E1）**: wire フィールド名を **`requestId`** に一本化（ヘッダ `x-dub-request-id`）。旧 `correlationId` は廃止。エンベロープ / `ErrorResponse` / `AuditRecordInput` / `x-dub-*` の語彙が1語で揃う。
- **`DUB_DEFAULT_ORG_ID`（E4）**: 暫定 `"org_devhub"`（prefix-ULID 規約準拠）。**infra-d1-seed の org 固定値が正本**であり、seed 確定時にその値へ揃える（要追随）。
- **enum 開閉**: 状態機械は closed union（`TaskStatus`5 / `EventPhase`6 / `NotificationChannel`4）。エラーコード・audit action は open。
- **`ErrorResponse`**: 設計どおり所有は `@dub/errors`（`@dub/types` は errors を import しない＝循環回避）。

## 次波（サービス実装）の前提・残課題

- **infra/monorepo (#27) と infra-d1-seed (#28)**: `NAMESPACE_REGISTRY`（`@dub/db` の `Namespace` 型を import する拡張構造）、`infra/d1/migrations/<ns>/` の物理集約と集約適用、Service Binding 名レジストリ（`SVC_*`）、CODEOWNERS/CI lint。本波では未着手。
- **要ユーザー決裁（P0b C章）**: 9-B(Workspace/mail 送信プロバイダ=SES暫定)・9-C(RT=DO 本決定)・9-E(Workers Paid＋コスト上限＝Queue 実作成の前提)・α(招待制/ブランドカラー等)。mail/chat/mobile 系の型は 2段スタブ（②群 STUB）で凍結済み・実結線は決裁後。
- **`@dub/tokens` のブランド値（α-11）**: 形は凍結、色値は初期抽出。#7 デザイナーレビュー後に調整予定。
- **CONTRACT_VERSION**: `1.0.0`。凍結の最終サインオフ（E1/E4 の Apply 確定）後に据える。
