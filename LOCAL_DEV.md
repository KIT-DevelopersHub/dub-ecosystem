# LOCAL_DEV — ローカル開発フロー

本番デプロイせずに、ローカルで起動してパパッと試しながら作るための手順。全サービスは Cloudflare Workers（`wrangler dev --local` = miniflare、ネット不要・CF アカウント不要）。**非力 PC 配慮：16 サービスを同時起動しない。機能ごとに必要な数個だけ起動し、使い終わったら停止する。**

## 目次

- [1. 結論（最短経路）](#1-結論最短経路)
- [2. 前提セットアップ](#2-前提セットアップ)
- [3. ローカル DB を用意する（dev:seed）](#3-ローカル-db-を用意するdevseed)
- [4. サービスを起動する（機能別に必要な分だけ）](#4-サービスを起動する機能別に必要な分だけ)
- [5. フロント（fe2 SPA）をローカル gateway に向ける](#5-フロントfe2-spaをローカル-gateway-に向ける)
- [6. 通し確認（ログイン→me→名簿→メール）](#6-通し確認ログインme名簿メール)
- [7. メール送信はローカルでは実送信しない](#7-メール送信はローカルでは実送信しない)
- [8. トラブルシュート](#8-トラブルシュート)
- [9. 仕組みメモ（なぜ dev:seed が要るか）](#9-仕組みメモなぜ-devseed-が要るか)

## 1. 結論（最短経路）

- **とにかくフロントだけ触りたい**（バックエンド不要）: `apps/fe2-app-shell` を `VITE_DEMO=1` で起動。自動ログイン＋全画面にシード済みデータが乗る。

  ```bash
  pnpm install
  VITE_DEMO=1 pnpm dev:fe2        # http://localhost:5173
  ```

- **ログイン〜メール〜名簿を実サービスで通す**（コア一式）: 一度だけ seed し、必要な Worker をターミナル別に起動。

  ```bash
  pnpm install && pnpm build      # 契約パッケージを dist 出力（サービスが参照）
  pnpm dev:seed                   # ローカル D1(dub-core) に migration + デモ seed
  # 別ターミナルでそれぞれ:
  pnpm dev:identity   # :8790
  pnpm dev:auth       # :8788
  pnpm dev:gateway    # :8787  ← SPA / curl はここを叩く
  pnpm dev:mail       # :8791  （メールを試す時だけ）
  ```

理由: 全 Worker を立てる必要はない。検証対象と、その Service Binding 依存先だけ起動すれば足りる（例: `/me` を見るなら gateway + auth + identity の 3 つ）。`wrangler dev` は同じマシンで起動中の他 Worker を dev レジストリ経由で自動解決するので、Service Binding はローカル同士でつながる。

## 2. 前提セットアップ

```bash
pnpm install     # wrangler / tsx も devDependency として入る（npx 不要）
pnpm build       # turbo: @dub/* 契約パッケージを依存順に dist 出力
```

`pnpm build` を省くと、サービスが参照する `@dub/types` 等の `dist` が無く `wrangler dev` のバンドルが失敗する。

## 3. ローカル DB を用意する（dev:seed）

```bash
pnpm dev:seed                          # 既定シナリオ conference-demo
pnpm dev:seed --scenario minimal       # 最小（org/user/task 少数）
pnpm dev:seed --scenario rbac-matrix   # 権限マトリクス検証用
```

`pnpm dev:seed` は毎回 `.wrangler-local/`（共有 miniflare state・gitignore 済み）を作り直し、`infra/d1` の **migration（forward-only 全適用）＋ seed（デモデータ）** を `dub-core` を束ねる各サービスのローカル D1 に投入する。**起動中のサーバがあると state を消すので、seed は起動前に実行する。**

シード済みのデモアカウント（パスワード不要・ローカルは test-login でログイン）:

| 表示名 | userId | email | ロール |
|---|---|---|---|
| Demo Admin | `user_01SEED000000000000000ADMIN` | demo-admin@dev.developershub.jp | admin（全権限） |
| Demo Organizer | `user_01SEED00000000000000ORGNZ` | demo-organizer@dev.developershub.jp | organizer |
| Demo Member | `user_01SEED00000000000000MEMBER` | demo-member@dev.developershub.jp | member |

> 注: seed のデモ管理者は `demo-admin@dev.developershub.jp`（`@dev.` サブドメイン、`google-sub` ベースでパスワード無し）。ローカルのログインは email+password ではなく **`/auth/test-login`（userId 指定）** を使う（`dev:auth` は `ENVIRONMENT=local`＋`DUB_TEST_LOGIN=1` で有効）。

## 4. サービスを起動する（機能別に必要な分だけ）

各 `pnpm dev:<svc>` は 1 Worker を `wrangler dev --local`＋共有 `--persist-to .wrangler-local` で起動する。一覧は `pnpm dev:list`。

| 起動コマンド | サービス | ポート | ローカル用の上書き |
|---|---|---|---|
| `pnpm dev:identity` | identity-roster | 8790 | なし |
| `pnpm dev:auth` | auth-service | 8788 | `ENVIRONMENT=local` `DUB_TEST_LOGIN=1` `COOKIE_DOMAIN=""`（localhost 用ホスト限定 cookie） |
| `pnpm dev:gateway` | api-gateway | 8787 | なし（唯一の外部入口。SPA / curl はここ） |
| `pnpm dev:mail` | mail-gateway | 8791 | `MAIL_OUTBOUND_PROVIDER=mock`（実送信しない） |

起動セットの選び方（依存だけ立てる）:

| 検証したいもの | 立てる Worker |
|---|---|
| ログイン / セッション | auth（+ identity） |
| gateway 経由の `/api/v1/me` | gateway + auth + identity |
| ユーザー名簿（roster） | gateway + auth + identity |
| メール送信（スタブ） | mail（+ 必要なら identity で mail:send 認可） |

非力 PC 配慮: 同時起動は最小限に。使い終わった `wrangler dev` は Ctrl-C で停止する。

## 5. フロント（fe2 SPA）をローカル gateway に向ける

`apps/fe2-app-shell/env.local.example` を `.env.local` にコピーして起動する:

```bash
cp apps/fe2-app-shell/env.local.example apps/fe2-app-shell/.env.local
pnpm dev:gateway        # 先にローカル gateway を起動（+ auth + identity）
pnpm dev:fe2            # http://localhost:5173 → VITE_API_BASE_URL=http://localhost:8787
```

`.env.local` の `VITE_API_BASE_URL=http://localhost:8787` でローカル gateway に向く（既定は live workers.dev gateway）。バックエンド不要で全画面を触るだけなら `VITE_DEMO=1`（同ファイルにコメントで記載）。

## 6. 通し確認（ログイン→me→名簿→メール）

seed 済み・gateway/auth/identity 起動済みの前提。（cookie は `Secure` なのでブラウザ（localhost は secure 扱い）では効くが、curl は http で落とすため以下は Bearer トークンで確認する。）

```bash
# 1) test-login（ローカルのみ）→ token
TOKEN=$(curl -s -X POST http://127.0.0.1:8787/api/v1/auth/test-login \
  -H 'content-type: application/json' \
  -d '{"userId":"user_01SEED000000000000000ADMIN"}' | sed -E 's/.*"token":"([^"]+)".*/\1/')

# 2) /me（gateway が auth verify + identity 合成）
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:8787/api/v1/me

# 3) 名簿（identity:read 認可つき）
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:8787/api/v1/identity/users

# 4) メール送信（mock provider・実送信なし。dev:mail を起動して直接叩く）
curl -s -X POST http://127.0.0.1:8791/send \
  -H 'x-dub-internal: 1' -H "x-dub-idempotency-key: local-$(date +%s)" \
  -H 'content-type: application/json' \
  -d '{"to":[{"email":"someone@example.com"}],"subject":"local test","textBody":"hi"}'
```

期待: `/me` にシードの Demo Admin と権限一覧、`/users` に 3 名、`/send` は `202` で `messageId` を返す（メールは飛ばない）。

## 7. メール送信はローカルでは実送信しない

`pnpm dev:mail` は `MAIL_OUTBOUND_PROVIDER=mock` を渡すので、送信は in-memory の `MockMailProvider` が受ける（Resend/SES への実配送は起きない）。send-log 行は書かれるので冪等性やレスポンス契約は本物どおり確認できる。**Resend の API キーはローカルに設定しないこと**（設定しても mock が優先。実キーは本番 Worker のみ）。

## 8. トラブルシュート

| 症状 | 対処 |
|---|---|
| `wrangler dev` が `not of type 'function or ExportedHandler'` で落ちる | Worker の entry `index.ts` が **default 以外の値 named export** を持つと workerd が拒否する。値の再エクスポートは各モジュール（`./schema` 等）から直接 import する（本 PR で identity/auth を修正済み）。 |
| `dist` が無い / `@dub/*` 解決失敗 | `pnpm build` を先に実行。 |
| SPA でログインが保持されない | `dev:auth` で `COOKIE_DOMAIN=""` になっているか確認（toml 既定の `.developershub.jp` は localhost で拒否される）。`.env.local` の gateway URL も確認。 |
| seed したのにデータが空 | 起動中に seed すると state を消す。**全サーバを停止 → `pnpm dev:seed` → 起動** の順にする。 |
| ポート衝突 | 既定 8787/8788/8790/8791。使用中プロセスを停止（`lsof -ti:8787 | xargs kill`）。 |

## 9. 仕組みメモ（なぜ dev:seed が要るか）

`pnpm db:seed`（infra/d1）は **自前の node:sqlite ファイル**（`infra/d1/.wrangler/local-dub-core.sqlite`）に seed する高速パスで、`wrangler dev` が読む **miniflare のローカル D1 とは別物**。両者はつながらない。`pnpm dev:seed` はこのギャップを埋めるスクリプト（`scripts/local/seed-local.ts`）で、infra/d1 の migration（`applyAll`）と seed（`seedScenario`）ロジックを **SQL 記録アダプタ経由でそのまま再利用**して 1 本の `.sql` を生成し、`wrangler d1 execute --local` で miniflare の `dub-core` に流し込む。だから起動中の Worker が同じデモデータを見られる。

起動オーケストレータは `scripts/local/dev.mjs`（`pnpm dev:<svc>` から呼ばれる）。共有 `--persist-to .wrangler-local` とポート・ローカル用 var の上書きだけを付けて 1 Worker を起動する。
