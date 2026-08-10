# Deploy Runbook

本番/preview へのデプロイ手順。**この文書は手順のみで、実デプロイは行わない。** 現状は P0b 凍結（Worker スケルトン + `REPLACE_AT_DEPLOY` プレースホルダ）であり、実 Apply は infra (#27/#28) の CI パイプラインで行う前提。ここではその前提で「何を・どの順で・何を確認するか」を残す。

## 目次

- [1. 前提と結論](#1-前提と結論)
- [2. CF API トークン要件](#2-cf-api-トークン要件)
- [3. D1: 作成と migration 適用](#3-d1-作成と-migration-適用)
- [4. サービスのデプロイ依存順](#4-サービスのデプロイ依存順)
- [5. Secret 一覧（キー名のみ）](#5-secret-一覧キー名のみ)
- [6. スモーク項目](#6-スモーク項目)
- [7. ロールバック](#7-ロールバック)

## 1. 前提と結論

結論: デプロイは「D1 を作る → migration を forward-only で当てる → サービスを依存順（identity → auth → gateway → 周辺 → BFF）に置く → 各面をスモーク」の順で進める。逆順に置くと Service Binding の解決先 Worker が存在せずデプロイが失敗する。

理由: api-gateway は 14 本の Service Binding（`SVC_AUTH` 等）を持ち、mobile-bff も `SVC_AUTH`/`SVC_IDENTITY` 等に依存する。bind 先 Worker が未デプロイだと wrangler が bind を解決できない。D1 は全サービスの `DB` bind の実体なので最初に用意する。

事前チェック（Apply 前に必ず）:

- `database_id` / KV `id` が各 `wrangler.toml` でまだ `REPLACE_AT_DEPLOY` / `REPLACE_AT_APPLY` のままでないか（実 ID に差し替え済みか）。
- Service Binding の `service = "..."` 値と、bind 先 Worker の `name = "..."` が一致しているか。**現状 api-gateway 側は `dub-auth-service` / `dub-identity-roster` を参照するが、対応 Worker の `name` は `auth-service` / `identity-roster` で prefix が不一致。** infra 名前レジストリ (#27) の確定値で両者を揃えてからデプロイする（不一致のままだと bind 解決に失敗する）。

## 2. CF API トークン要件

デプロイ用トークンに必要な権限（最小）:

- Account / **Workers Scripts**: Edit — Worker 本体の deploy。
- Account / **D1**: Edit — DB 作成・migration 適用。
- Account / **Workers KV Storage**: Edit — auth/chat/drive/gantt の KV namespace。
- Account / **Queues**: Edit — 12 本の Queue + DLQ の producer/consumer 結線。
- Account / Workers Scripts の Secret 書き込みは Workers Scripts:Edit に含まれる。

トークンは CF 専用アカウント（`developershub.jp` 保有アカウント）で発行する。値はローカルのみ保管し、リポジトリ・チャットに出さない。

```bash
# トークンをローカル env に置いて wrangler に渡す（値はコミットしない）
export CLOUDFLARE_API_TOKEN="<token>"
export CLOUDFLARE_ACCOUNT_ID="<account-id>"
wrangler whoami   # 権限とアカウントの確認
```

## 3. D1: 作成と migration 適用

D1 は単一共有 DB `dub-core`（preview は `dub-core-preview`）。定義断片は `infra/d1/wrangler.d1.jsonc`。

1. DB を作成し、返る `database_id` を各 `wrangler.toml` のプレースホルダへ反映する。

```bash
wrangler d1 create dub-core
wrangler d1 create dub-core-preview
```

2. migration は **forward-only**。物理 SQL は `infra/d1/migrations/<namespace>/NNNN_*.sql` に名前空間ごとに分かれている（identity は `0001_init` + `0002_system_roles` の 2 本、他は `0001_init`）。適用は台帳（`dub_migrations`）で冪等管理される。preview/prod への適用は infra #27 の CI（wrangler 経由）で行う。適用後にスキーマ検証を通す。

```bash
# 適用の実行主体は infra #27 の CI パイプライン（wrangler d1 migrations apply）。
# 適用順は台帳が管理するため手動で個別 SQL を流さない。
wrangler d1 migrations apply dub-core --remote
wrangler d1 migrations apply dub-core-preview --remote
```

3. 適用順の要点: `identity` 名前空間を最初に置く（他サービスが org/user を参照）。seed 名前空間（`seed_runs`）は本番ではデモ seed を流さない（seed はローカル/preview 検証用）。

## 4. サービスのデプロイ依存順

下段（依存される側）から順に。各 Worker のディレクトリで `wrangler deploy`（`deploy` script を持つのは auth/chat/drive-proxy/identity/task 等。持たないサービスは `wrangler deploy` を直接実行）。

| 段 | Worker（`name`） | ディレクトリ | 依存 |
|---|---|---|---|
| 0 | D1 `dub-core` / KV / Queues | `infra/d1` | なし（最初） |
| 1 | `identity-roster` | services/identity-roster | DB, AUDIT_QUEUE |
| 2 | `auth-service` | services/auth-service | AUTH_KV, SVC_IDENTITY |
| 3a | `event-service` | services/event-service | DB, 各 Queue producer |
| 3a | `task-service` | services/task-service | DB, SVC 群 |
| 3a | `gantt-service` | services/gantt-service | DB, KV, Queue consumer |
| 3a | `notification` | services/notification | DB, SVC_IDENTITY |
| 3a | `file-meta` | services/file-meta | DB, Queue |
| 3a | `drive-proxy` | services/drive-proxy | KV, Queue（D1 なし） |
| 3a | `chat-service` | services/chat-service | DB, DO `CHAT_ROOM` |
| 3a | `mail-gateway` | services/mail-gateway | DB, provider secret |
| 3a | `dub-mail-automation` | services/mail-automation | DB, Queue |
| 3a | `dub-deploy-service` | services/deploy-service | DB, Queue, CF token secret |
| 3a | `dub-github-sync` | services/github-sync | DB, Queue |
| 3a | `webhook-ingest` | services/webhook-ingest | DB, Queue |
| 3a | `audit-log` | services/audit-log | DB, Queue consumer（DLQ） |
| 4 | `dub-api-gateway` | services/api-gateway | 上記 14 サービスへの SVC bind |
| 5 | `mo3-mobile-bff` | apps/mo3-mobile-bff | SVC_AUTH/IDENTITY/EVENT/TASK/NOTIFICATION |

要点: identity → auth → （周辺サービス群 3a は相互の Service Binding を持たない範囲で並行可）→ gateway → BFF。gateway と BFF は最後（bind 先が出揃ってから）。

```bash
# 例: 1 サービスのデプロイ（各ディレクトリで）
cd services/identity-roster && wrangler deploy
# preview 環境を分けている場合
wrangler deploy --env preview
```

Secret は deploy 前に投入しておく（次節）。Worker が起動時に secret 不在でも P0 実装は LOUD stub に落ちる設計だが、本番では投入済みを前提にする。

## 5. Secret 一覧（キー名のみ）

**値は絶対にコミット・チャット・ログに出さない。** ローカル env から `wrangler secret put <KEY>` で各 Worker に投入する。

| Worker | Secret キー |
|---|---|
| api-gateway | `TURNSTILE_SECRET` |
| auth-service | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_MOBILE_IOS_CLIENT_ID`, `GOOGLE_MOBILE_ANDROID_CLIENT_ID` |
| chat-service | `WS_TICKET_SECRET`（DO と同一 HMAC） |
| drive-proxy | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` |
| github-sync | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_SECRET` |
| deploy-service | `CF_ACCOUNT_ID`, `CF_DEPLOY_TOKEN_PAGES`, `CF_DEPLOY_TOKEN_DNS`, `CF_DEPLOY_TOKEN_READ` |
| mail-gateway | provider 依存: SES = `SES_ACCESS_KEY_ID` + `SES_SECRET_ACCESS_KEY`（+ 非secret `SES_REGION`/`MAIL_FROM_ADDRESS`）／ Resend = `RESEND_API_KEY`／ MailChannels = `MAILCHANNELS_API_KEY` |
| mo3-mobile-bff | `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `FCM_SERVICE_ACCOUNT_JSON`, `FCM_PROJECT_ID` |

```bash
# 投入（対象 Worker のディレクトリで実行 / 値は対話入力・履歴に残さない）
cd services/auth-service && wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret list   # 投入済みキー名の確認（値は表示されない）
```

非 secret 設定（`ALLOWED_ORIGINS`, `COOKIE_DOMAIN`, `SESSION_*_TTL_SEC`, `DUB_DEFAULT_ORG_ID="org_devhub"` 等）は各 `wrangler.toml` の `[vars]` にある。本番 origin/redirect の allowlist が正しいかを確認する。

## 6. スモーク項目

デプロイ直後の最小確認。詳細な障害初動は [03-oncall.md](./03-oncall.md)。

| # | 項目 | 手段 | 期待 |
|---|---|---|---|
| 1 | gateway liveness | `GET https://api.developershub.jp/healthz` | 200 `{status:"ok", version, requestId}` |
| 2 | mobile-bff liveness | `GET https://m-api.developershub.jp/healthz` | 200 `{ok:true}` |
| 3 | 内部 health（各サービス） | Service Binding 経由 or 内部呼び出しで `/health`（gantt/deploy/chat/task/event/identity/auth）・`/internal/health`（notification/mail-gateway/audit-log/webhook-ingest/file-meta） | 200 |
| 4 | mail 送信 readiness | `GET /internal/health/ready`（mail-gateway, `x-dub-internal:1` 必須） | provider 結線済みで 200 / 未結線で 503（issues 列挙） |
| 5 | Service Binding 解決 | gateway 経由で `GET /api/v1/me`（要 auth） | 上流 identity/auth へ透過され応答 |
| 6 | CORS/origin | 本番 SPA origin から preflight | `ALLOWED_ORIGINS` に一致し許可 |
| 7 | レート制限ヘッダ | 任意 `/api/v1/*` レスポンス | `ratelimit-limit`/`ratelimit-remaining`/`ratelimit-reset` が付与 |
| 8 | migration 台帳 | `wrangler d1 migrations list dub-core` | 未適用 migration が残っていない |

スモークで request-id を控えておくと、失敗時にログ突合（03 節）へ直結できる。

## 7. ロールバック

- Worker: 直前バージョンへ戻す（`wrangler rollback` または直前コミットで再 deploy）。
- D1: migration は forward-only。ロールバック用の down は持たない。破壊的変更は「新しい前方 migration で打ち消す」方針。適用前に preview で必ず検証する。
- 依存順の逆: gateway/BFF を先に戻すと bind 先が新旧混在になり得る。gateway → 周辺 → auth → identity の逆順で戻す。
