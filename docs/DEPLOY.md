# Auto-Deploy (CI → production)

本番デプロイは **main へのマージで自動実行** される（`.github/workflows/deploy.yml`）。
「人/エージェントが CI を見て手で `wrangler deploy` する」運用をやめ、デプロイが監視者の
idle で黙って未実行になる単一障害点を排除するのが目的。

- 手順（何を・どの順で・何を確認するか）の詳細は [runbooks/01-deploy.md](./runbooks/01-deploy.md)。
- この文書は **CI 自動デプロイの契約**（必要な GitHub secrets・権限・流れ・手動起動）に絞る。

## 目次

- [1. 結論（流れ）](#1-結論流れ)
- [2. 必要な GitHub secrets / variables](#2-必要な-github-secrets--variables)
- [3. Cloudflare API トークンの権限](#3-cloudflare-api-トークンの権限)
- [4. デプロイ順序と理由](#4-デプロイ順序と理由)
- [5. ヘルスチェックと fail-fast](#5-ヘルスチェックと-fail-fast)
- [6. 手動起動（workflow_dispatch）](#6-手動起動workflow_dispatch)
- [7. D1 マイグレーション](#7-d1-マイグレーション)
- [8. Worker secrets は壊さない](#8-worker-secrets-は壊さない)

## 1. 結論（流れ）

```
main に merge (= push)
  -> deploy.yml が発火
  -> 同一ジョブ内で typecheck + test + build（緑ゲート。赤ならデプロイしない）
  -> infra/deploy/deploy-prod.sh を実行
       identity-roster -> auth-service -> 周辺サービス群 -> api-gateway
       -> [gateway スモーク: /healthz=200, /api/v1/me=401] -> fe2-app-shell -> mo3-mobile-bff
```

緑ゲートは `ci.yml` と同じ検査をデプロイジョブ内で再実行する方式。`workflow_run` に依存
しないので、デプロイされる木そのものが緑であることを保証でき、クロスワークフローの
SHA/ブランチ解決の癖を避けられる。

デプロイ順序と各コマンドの単一の正本は `infra/deploy/deploy-prod.sh`。CI もローカル手動
（`bash infra/deploy/deploy-prod.sh`）も同じスクリプトを通るので、CI と手動で手順がずれない。

## 2. 必要な GitHub secrets / variables

Settings → Secrets and variables → Actions で設定する。

| 種別 | 名前 | 必須 | 用途 |
|---|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | **必須** | wrangler が本番 Worker を deploy するための CF API トークン |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | 任意 | トークンが複数アカウントに跨る場合のみ。単一アカウントなら不要 |
| Variable | `VITE_API_BASE_URL` | 任意 | fe2 SPA のビルド時 API ベース URL。未設定なら workers.dev の既定値 |
| Variable | `GATEWAY_HEALTH_URL` | 任意 | gateway スモークの向き先 origin。未設定なら workers.dev の既定値 |
| Variable | `MOBILE_BFF_HEALTH_URL` | 任意 | 設定した場合のみ mobile-bff `/healthz` をスモークする |
| Variable | `DEPLOY_APPLY_MIGRATIONS` | 任意 | 既定 false（no-op）。remote 適用を配線した後にのみ true。§7 参照 |

トークン値は **リポジトリ・チャット・ログに出さない**。GitHub Secret にのみ格納する。
`environment: production` を使っているので、Settings → Environments → production に
required reviewers を付ければデプロイを承認制にできる（初回 run で environment は自動作成）。

## 3. Cloudflare API トークンの権限

CF 専用アカウント（`developershub.jp` 保有アカウント）でトークンを発行する。最小権限:

| スコープ | 権限 | 理由 |
|---|---|---|
| Account / Workers Scripts | Edit | Worker 本体の deploy（Worker secret 書き込みもここに含まれる） |
| Account / D1 | Edit | 各 Worker の `DB` bind 実体（dub-core）へのアクセス |
| Account / Workers KV Storage | Edit | auth/chat/drive/gantt の KV namespace bind |

無料枠構成のため Queues/Turnstile は使わない（`wrangler.free.toml`）。paid 構成
（`wrangler.toml`）を CI で使う場合は Queues:Edit も要る。

## 4. デプロイ順序と理由

順序は `infra/deploy/deploy-prod.sh` が保持する。**下段（依存される側）から順に置く。**

1. `identity-roster` — org/user lookup の土台。他が参照する。
2. `auth-service` — `SVC_IDENTITY` を bind するので identity の後。
3. 周辺サービス群（相互に Service Binding を持たないので順不同）:
   `event-service` / `task-service` / `gantt-service` / `notification` / `file-meta` /
   `drive-proxy` / `chat-service` / `mail-gateway` / `deploy-service` / `github-sync` / `audit-log`
4. `api-gateway` — 14 本の `SVC_*` を bind するので、上流が出揃ってから最後に。
5. `fe2-app-shell` — 静的 SPA（assets）。ビルド時に prod gateway URL を焼き込み済み。
6. `mo3-mobile-bff` — `SVC_AUTH/IDENTITY/EVENT/TASK/NOTIFICATION` を bind。

理由: bind 先 Worker が未デプロイだと wrangler が Service Binding を解決できずデプロイが
失敗する。逆順に置くとロックアウトする。

## 5. ヘルスチェックと fail-fast

`deploy-prod.sh` は api-gateway を置いた **直後**（fe2/mo3 を公開する前）に fail-fast する:

| 対象 | 期待 | 何を守るか |
|---|---|---|
| `GET {gateway}/healthz` | 200 | gateway が生きて自己申告 ok |
| `GET {gateway}/api/v1/me`（未認証） | 401 | ルーティング健全性。**ここが 404 なら route 退行 = auto-deploy を作った動機の障害そのもの** |
| `GET {mobile-bff}/healthz` | 200 | `MOBILE_BFF_HEALTH_URL` を設定した時のみ |

いずれかが期待と違えば以降を止めて（`exit 1`）ジョブを失敗させる。gateway スモークを
fe2/mo3 の前に置くのは、公開面を出す前に壊れを検知するため。

## 6. 手動起動（workflow_dispatch）

Actions → 「Deploy (production)」→ Run workflow で任意起動できる。

- 入力 `skip_healthcheck`（既定 false）: スモークを飛ばして deploy だけ行う。
- CLI: `gh workflow run deploy.yml --ref main -f skip_healthcheck=false`

## 7. D1 マイグレーション

dub-core への migration は **forward-only + 冪等**（台帳 `dub_migrations` + `CREATE ... IF
NOT EXISTS`）。ただし本リポジトリには **remote 適用コマンドがまだ配線されていない**:
`infra/d1/scripts/migrate.ts` は `--env local`（node:sqlite）専用で、名前空間分割された
物理レイアウトは infra パイプライン側で out-of-band に適用する前提。

そのため workflow の migration ステップは既定で **no-op**（`DEPLOY_APPLY_MIGRATIONS` 未設定/
false）。schema を中途半端に当てないための安全側の既定。remote 適用手段を用意したら、
deploy.yml の該当ステップに実コマンドを書き、repo variable `DEPLOY_APPLY_MIGRATIONS=true`
にして有効化する。ステップの位置は既に「サービス deploy の前」に置いてある。

## 8. Worker secrets は壊さない

`wrangler deploy` は既存の `wrangler secret`（`PASSWORD_ENC_KEY` 等）を **保持** する。
このパイプラインは Worker secret を put/削除しない。新規 secret の投入は
[runbooks/01-deploy.md §5](./runbooks/01-deploy.md) の手順で個別に行う。
