# On-Call / Incident Response Runbook

障害対応の**初動**手順。原因の恒久対処より先に「状況を掴む・被害を止める」までを最短で行う。**手順のみ。**

## 目次

- [1. 初動 3 手（結論）](#1-初動-3-手結論)
- [2. ログの読み方（相関 ID 起点）](#2-ログの読み方相関-id-起点)
- [3. health / ready の確認](#3-health--ready-の確認)
- [4. レート制限（429）の切り分け](#4-レート制限429の切り分け)
- [5. 症状別クイックリファレンス](#5-症状別クイックリファレンス)
- [6. エスカレーション](#6-エスカレーション)

## 1. 初動 3 手（結論）

結論: (1) 外部 2 面の health を見る → (2) 該当 request-id でログを串刺し → (3) 影響範囲（1 サービスか横断か）を確定してから対処に入る。

理由: エコシステムは gateway/BFF の 2 面が外部入口で、内部は Service Binding + Queue の連鎖。入口の health と相関 ID があれば「どのサービスで落ちたか」を数分で特定できる。闇雲に各サービスを触ると横断障害を悪化させる。

```bash
# まず入口 2 面の生存
curl -s https://api.developershub.jp/healthz     # gateway
curl -s https://m-api.developershub.jp/healthz   # mobile-bff
```

## 2. ログの読み方（相関 ID 起点）

全リクエストは相関 ID `x-dub-request-id`（wire では `requestId`）を持ち、gateway → 上流サービス → Queue まで伝播する。エラーレスポンス・監査レコード・構造化ログすべてに同じ ID が載る。

1. ユーザー報告やスモーク失敗のレスポンスから `x-dub-request-id` を採取する。
2. その ID で各 Worker のログを串刺しする。

```bash
# 対象 Worker の live ログ（別ターミナルで各サービス）
wrangler tail dub-api-gateway --format=json
wrangler tail auth-service --format=json
# 採取した request-id で絞り込み（例）
wrangler tail dub-api-gateway --format=json | grep "<request-id>"
```

3. ログ/監査に秘密情報は出ない設計（`authorization`/`cookie`/`token`/`secret` 等は `redactSecrets` でマスク）。マスク済みでも値を外部に貼らない。
4. エラーは `DubError` の SCREAMING_SNAKE コード（`ErrorResponse` の `code`）で分類できる。コードとステータスで発生サービスを絞る。

## 3. health / ready の確認

liveness（生存）と readiness（依存結線）は別物。ready が 503 でも liveness は 200 のことがある。

| Worker | エンドポイント | 種別 | 備考 |
|---|---|---|---|
| api-gateway | `GET /healthz` | liveness | 公開・認証なし。`{status,version,requestId}` |
| mobile-bff | `GET /healthz` | liveness | 公開 |
| auth / identity / task / event / gantt / deploy / chat | `GET /health` | liveness | サービス内部 |
| notification / mail-gateway / audit-log / webhook-ingest / file-meta | `GET /internal/health` | liveness | 内部のみ |
| mail-gateway | `GET /internal/health/ready` | readiness | `x-dub-internal:1` 必須。provider 未結線で **503** + issues 列挙 |
| mail-gateway | `GET /health/quota` | 自己申告 | 送信クォータ |
| drive-proxy | `GET /drive/health/quota` | 自己申告 | Google クォータ（内部） |

初動: liveness が落ちていれば Worker/デプロイ側の障害（[deploy runbook](./01-deploy.md) のロールバックを検討）。liveness OK で ready が 503 なら secret/依存の結線切れ（Secret 一覧を確認）。

## 4. レート制限（429）の切り分け

api-gateway が全 `/api/v1/*` にレート制限を掛ける。外部契約は **429 + ヘッダのみ**。

- 通常時レスポンス: `ratelimit-limit` / `ratelimit-remaining` / `ratelimit-reset`。
- 制限時: HTTP **429** + `Retry-After` + `ratelimit-remaining: 0` + `x-dub-request-id`、body は `RATE_LIMITED` の `ErrorResponse`。

切り分け:

- 特定 IP のみ 429: `cf-connecting-ip` 単位の正常なスロットリング（限界値到達）。クライアント側のリトライ間隔を確認。
- 全体的に 429 急増: 現状の limiter は **Worker インメモリの固定窓**（`createInMemoryRateLimiter`）。CF native の `RATE_LIMITER` binding は P0 未結線のため、インスタンス跨ぎで挙動が揃わない点に留意。閾値見直しや native binding 結線は infra 側の対応。
- UI に「レート制限」バナーが出る: フロントが 429 + `Retry-After` を受けて表示している。バックエンドの 429 発生元（gateway ログの request-id）を追う。

## 5. 症状別クイックリファレンス

| 症状 | 初動の見どころ |
|---|---|
| gateway 500 / bind エラー | gateway ログの request-id → どの `SVC_*` bind か。bind 先 Worker の liveness と、`service=` 名と `name=` 一致（deploy runbook 事前チェック）を確認 |
| ログインできない | auth-service `/health`、Google OAuth secret の投入状況、`REDIRECT_ALLOWLIST`/`COOKIE_DOMAIN` の env 値 |
| メールが飛ばない | mail-gateway `/internal/health/ready`（503 なら provider secret 未結線）→ `/health/quota` |
| 通知が来ない | notification `/internal/health` と Queue consumer（`dub-q-evt-notification` / DLQ 滞留）を確認 |
| Queue 滞留 / 再試行地獄 | 対象 DLQ（`*-dlq`）のメッセージ有無。consumer 側 Worker のログを request-id で追う |
| DB エラー | D1 `dub-core` の migration 台帳（`wrangler d1 migrations list`）と、名前空間所有（`infra/d1/src/registry.ts`）の整合 |
| 全 API 429 | 4 節参照。インメモリ limiter の窓とインスタンス数を確認 |

## 6. エスカレーション

- 影響が単一サービスに閉じる → 該当 Worker のロールバック（[deploy runbook 7 節](./01-deploy.md#7-ロールバック)）で暫定復旧し、原因を後追い。
- 横断（gateway/D1/Queue 基盤）→ 拡大を止めるため入口（gateway/BFF）で切り戻しを優先。D1 は forward-only なので down は打たず、前方 migration で打ち消す。
- secret 漏洩の疑い → 該当 secret を `wrangler secret put` で即ローテーション。値はローカルのみで扱い、ログ/チャットに残さない。
- 一次対応後: 発生時刻・request-id・影響範囲・暫定対処を記録し、恒久対処（根本原因 + 再発防止）へ引き継ぐ。
