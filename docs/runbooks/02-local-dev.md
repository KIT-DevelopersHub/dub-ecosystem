# Local Development Runbook

ローカルで DB を用意し、サービスを起動し、e2e スモークを通すまでの手順。**手順のみ。** ローカルは重いサーバの多重起動を避け、必要な Worker だけを立てる。

## 目次

- [1. 結論（最短経路）](#1-結論最短経路)
- [2. 初期セットアップ](#2-初期セットアップ)
- [3. D1 reset / seed](#3-d1-reset--seed)
- [4. 各サービスのローカル起動](#4-各サービスのローカル起動)
- [5. e2e スモーク](#5-e2e-スモーク)
- [6. 型・テストの通し確認](#6-型テストの通し確認)

## 1. 結論（最短経路）

結論: `pnpm install` → D1 を reset+seed → 使う Worker だけ `wrangler dev` → health と代表 API を叩いてスモーク。

理由: 全 16 Worker を同時に立てる必要はない。検証対象と、その Service Binding 依存先だけを起動すれば足りる（例: gateway 経由の `/me` を見るなら gateway + auth + identity の 3 つ）。

> 注: リポジトリに `pnpm db:reset` エイリアスは未定義。DB 操作は `infra/d1` の `d1:*` script（内部で `scripts/migrate.ts` を呼ぶ）を使う。`reset` サブコマンドが「初期化 → migrate → seed → verify」を一括で行う。

## 2. 初期セットアップ

```bash
pnpm install
pnpm build      # turbo: 契約パッケージを依存順に dist 出力（サービスが参照）
```

## 3. D1 reset / seed

ローカル D1 は miniflare のローカル SQLite ではなく、`infra/d1` の node:sqlite ファイル（`.wrangler/local-dub-core.sqlite`）で高速に回す。CLI は `--env local` のみ対応（preview/prod は infra CI 側）。

```bash
cd infra/d1

# migrate のみ（forward-only 適用 + スキーマ verify）
pnpm d1:migrate

# seed のみ（既定シナリオ conference-demo・冪等）
pnpm d1:seed

# reset = 初期化 → migrate → seed → verify を一括（DB をやり直したい時はこれ）
node --import tsx scripts/migrate.ts reset

# シナリオ指定（minimal / conference-demo / rbac-matrix）
node --import tsx scripts/migrate.ts reset --scenario rbac-matrix
```

seed シナリオ:

- `minimal`: 最小の org/user のみ。
- `conference-demo`（既定）: デモ用の org・複数 user・通知・ファイル等を投入。動作確認向き。
- `rbac-matrix`: 権限（RBAC）検証用の役割マトリクス。

verify が `ok:false` を返したら migration/スキーマのドリフト。`d1:lint`（`pnpm d1:lint`）で SQL/命名規約も点検できる。

## 4. 各サービスのローカル起動

各 Worker は `wrangler dev` で起動する（サービスは `dev` script 未定義のため wrangler を直接使う）。auth-service は `[env.local]` に `DUB_TEST_LOGIN="1"` を持ち、テストログインが使える（local/preview のみ）。

```bash
# 単体で起動（それぞれ別ターミナル / ローカル D1 を参照）
cd services/identity-roster && wrangler dev --env local
cd services/auth-service    && wrangler dev --env local
cd services/api-gateway     && wrangler dev

# ローカルの Service Binding 解決には、bind 先 Worker も dev で起動しておく。
# wrangler の multi-worker dev（同一コマンドで複数 Worker）を使う場合は各 name を揃える。
```

起動対象の選び方（依存だけ立てる）:

| 検証したいもの | 立てる Worker |
|---|---|
| ログイン/セッション | auth-service（+ identity-roster） |
| gateway 経由の `/api/v1/me` | api-gateway + auth-service + identity-roster |
| タスク/ガント | task-service + gantt-service（+ identity for authz） |
| 通知 | notification（+ identity） |

非力 PC 配慮: 同時起動は最小限に。重いサーバ/GPU は起動しない。使い終わった `wrangler dev` は停止する。

## 5. e2e スモーク

seed 済み DB を前提に、health → 認証 → 代表 API の順で確認する。request-id を控えるとログ突合が楽。

```bash
# 1) liveness
curl -s localhost:8787/healthz            # api-gateway（ポートは wrangler dev の表示に従う）

# 2) テストログイン（local のみ・DUB_TEST_LOGIN=1）
#    auth-service の test-login でセッション Cookie を取得する。
curl -si localhost:8788/... # auth-service のローカルポート（起動ログのポートに合わせる）

# 3) 認証後の代表 API（gateway 経由・Cookie/セッション付き）
curl -s localhost:8787/api/v1/me
```

スモーク観点:

- health 系が全対象で 200。
- seed の org/user が `/me` 等に反映されている（conference-demo で投入した表示名が返る）。
- レスポンスに `ratelimit-*` ヘッダと `x-dub-request-id` が付く。
- UI を伴う確認は実ブラウザで行う（jsdom/grep はスモークにならない）。フロント（`apps/fe*`）は各 `pnpm dev`（Vite / Astro）でローカル起動し、`localhost:5173` 等から API を叩く。

## 6. 型・テストの通し確認

コードに触れた場合はルートで一括検証してから完了扱いにする。

```bash
pnpm typecheck      # turbo run typecheck（全パッケージ）
pnpm test           # turbo run test（vitest）
pnpm check          # typecheck + test を連続実行
```

infra/d1 のスキーマ関連を触ったら `cd infra/d1 && pnpm d1:lint && pnpm test` も通す。
