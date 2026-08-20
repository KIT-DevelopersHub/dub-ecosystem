# Staging + 「確認した」ラベルゲート (3環境デプロイ)

本番反映を **PR → staging で確認 → 「確認した」ラベル → 本番マージ** の順に固定し、口頭/チャット
の曖昧さを排して **ラベルで機械判定**する運用と、その CI 実装の手順書。

## 目次

- [1. 結論（3環境と流れ）](#1-結論3環境と流れ)
- [2. 環境モデル（全複製 staging・$0）](#2-環境モデル全複製-staging0)
- [3. 無料枠の実数（$0 の根拠）](#3-無料枠の実数0-の根拠)
- [4. ラベル運用（stagingへ / 確認した）](#4-ラベル運用stagingへ--確認した)
- [5. staging URL の出し方](#5-staging-url-の出し方)
- [6. ラベルゲートの二重強制](#6-ラベルゲートの二重強制)
- [7. staging bootstrap（一度だけ）](#7-staging-bootstrap一度だけ)
- [8. デモ seed の入れ方](#8-デモ-seed-の入れ方)
- [9. カットオーバー手順（ブランチ保護の適用）](#9-カットオーバー手順ブランチ保護の適用)
- [10. 生成規則（gen-staging-configs.sh）](#10-生成規則gen-staging-configssh)

## 1. 結論（3環境と流れ）

```
PR を作成
  -> 「stagingへ」ラベルを付ける
  -> staging.yml が -staging Worker 一式を staging にデプロイ
  -> PR に staging URL の sticky コメントが付く
  -> オーナーが staging URL で動作確認
  -> OK なら「確認した」ラベルを付ける
  -> prod-gate.yml のチェック confirm-gate が緑 -> main へマージ可能
  -> main マージで deploy.yml が本番へデプロイ（fail-close で確認したを再検証）
```

demo 環境は従来どおり（`apps/fe2-app-shell/wrangler.demo.toml` の `fe2-demo`）で変更なし。

## 2. 環境モデル（全複製 staging・$0）

staging は本番と**同型の全複製**。各 Worker は本番の `wrangler.free.toml` を
`infra/deploy/gen-staging-configs.sh` で変換した `wrangler.staging.toml` を使う。

| 環境 | Worker 名 | D1 | KV | 用途 |
|---|---|---|---|---|
| production | `dub-*`, `mo3-mobile-bff` | `dub-core` / `auth-outbox` | auth-session / drive-proxy-cache / gantt-cache | 本番 |
| **staging** | `dub-*-staging`, `mo3-mobile-bff-staging` | `dub-core-staging` / `auth-outbox-staging` | `*-staging` ×3 | PR 確認用（本番同型・デモ seed） |
| demo | `fe2-demo` | なし（in-app mock） | なし | バックエンド無しの見せ物 |

staging 対象 Worker（20本・`infra/deploy/staging-worker-set.sh` の順序＝本番と同じ依存順）:
identity-roster / auth-service / event-service / task-service / gantt-service / notification /
file-meta / drive-proxy / drive-share-service / chat-service / mail-gateway / deploy-service /
github-sync / audit-log / member-service / usage-meter / api-gateway / fe2-app-shell /
mo3-mobile-bff / app-health-monitor。

本番データは **コピーしない**（機密/PII 混入回避）。staging には代表的なデモ seed のみ投入（§8）。

## 3. 無料枠の実数（$0 の根拠）

CF アカウント `developershub-site`（`b8f6dd…`）で実測（2026-08-19）:

| 資源 | 無料枠 | 現状(prod) | +staging | 判定 |
|---|---|---|---|---|
| Worker scripts | 100 / account | 30 | +20 = **50** | ✅ 余裕 |
| リクエスト | 100k req/day（account 共有） | 小規模 | staging はレビュー時のみ | ✅ 合算でも収まる |
| D1 database | 10 | 2 | +2 = **4** | ✅ |
| KV namespace | 潤沢 | 4 | +3 = **7** | ✅ |
| Durable Objects | free は SQLite-backed のみ | 全 DO が `new_sqlite_classes` | staging も同型 | ✅ 無料 |
| **Cron Triggers** | **5 / account** | **5（満杯）** | **+0（生成時に除去）** | ⚠️→✅ 回避済 |
| Queues 等 paid binding | — | 不使用（`.free.toml`） | 不使用 | ✅ |

**唯一の注意点は Cron**。アカウントは既に 5/5（task / notification / mail-gateway / audit-log /
webhook-ingest）で満杯のため、staging が cron を足すと CF がデプロイを拒否する。
→ `gen-staging-configs.sh` が staging 生成時に **`[triggers]` を除去**（staging は cron を 0 本追加）。
その結果 staging のスケジュールジョブ（freeq ドレイン / 保持期間パージ / due-soon スキャン）は
**非稼働**。UI/フロー確認には影響しない。必要なら各サービスの内部 kick エンドポイントで手動実行。

結論: **全複製 staging は $0 で成立**（cron のみ生成時除去で回避）。

## 4. ラベル運用（stagingへ / 確認した）

| ラベル | 色 | 意味 / トリガ |
|---|---|---|
| `stagingへ` | （任意） | 付けると staging.yml が発火し、その PR を staging にデプロイ。以降その PR の push でも再デプロイ |
| `確認した` | `#0E8A16` | staging 確認済み。**本番マージの許可ゲート**。付いていない PR は（カットオーバー後）main にマージ不可 |

`確認した` は作成済み。`stagingへ` が未作成なら:

```
gh label create stagingへ --repo KIT-DevelopersHub/dub-ecosystem \
  --color 1D76DB --description "この PR を staging にデプロイして確認する"
```

## 5. staging URL の出し方

`staging.yml` が deploy 後に PR へ **sticky コメント**（`<!-- staging-deploy -->` マーカーで
更新）を投稿する:

- 管理画面 (fe2): `https://dub-fe2-app-shell-staging.developershub-site.workers.dev`
- api-gateway: `https://dub-api-gateway-staging.developershub-site.workers.dev`

オーナーは fe2 の URL を開いて確認 → OK なら `確認した` を付与。

## 6. ラベルゲートの二重強制

- **Gate #1（マージ時・prod-gate.yml）**: `pull_request` の `labeled`/`unlabeled` で
  再評価される必須チェック `confirm-gate`。`確認した` が無ければ赤。main のブランチ保護で
  この check を必須にすると、ラベル無しでは **merge ボタンがブロック**される（§9 で適用）。
- **Gate #2（デプロイ時・deploy.yml, fail-close）**: main に入った commit の元 PR が
  `確認した` を持っていたかを deploy 前に再検証し、無ければ deploy を中止（`exit 1`）。
  直 push / admin bypass / ラベル競合に対する保険。リポ変数 `PROD_LABEL_GATE=true` で有効化
  （既定 OFF＝現行の本番直行を壊さない）。`workflow_dispatch` の手動デプロイは対象外。

## 7. staging bootstrap（一度だけ）

staging の D1/KV/R2 を作成し、id を `infra/deploy/staging-resources.env` に書き込み、
スキーマ適用＋デモ seed まで行う:

```
export CLOUDFLARE_API_TOKEN=$(cat ~/Desktop/cf-token.txt)
bash infra/deploy/setup-staging-resources.sh
```

冪等（既存資源は再利用）。完了後 `staging-resources.env` の `REPLACE_ME_*` が実 id に変わる。
これが済むまで `deploy-staging.sh` / `gen-staging-configs.sh` は安全に停止する。

## 8. デモ seed の入れ方

`setup-staging-resources.sh` の最後で、リポジトリの移行/seed ロジック（`@dub/infra-d1` の
`d1:reset`）でローカル SQLite を本番同等スキーマ＋`conference-demo` シナリオで作り、
その `.dump`（CREATE + INSERT）を `dub-core-staging` にリモート適用する。**本番データは使わない**
（seed の prod ガードは `dub-core` のみ拒否＝`dub-core-staging` は許可）。seed シナリオを変えるには
`infra/d1/seed/scenarios.ts` を参照。

## 9. カットオーバー手順（ブランチ保護の適用）

進行中の本番直行案件が着地してから、オーナー合図で実施:

1. Gate #2 を有効化: リポ変数 `PROD_LABEL_GATE=true` を設定
   ```
   gh variable set PROD_LABEL_GATE --repo KIT-DevelopersHub/dub-ecosystem --body true
   ```
2. main のブランチ保護で必須チェックに `confirm-gate` と `typecheck · test · build` を要求
   （admin 権限。`ko-tarou` は admin:true）:
   ```
   gh api -X PUT repos/KIT-DevelopersHub/dub-ecosystem/branches/main/protection \
     -H "Accept: application/vnd.github+json" \
     -f 'required_status_checks[strict]=true' \
     -f 'required_status_checks[contexts][]=confirm-gate' \
     -f 'required_status_checks[contexts][]=typecheck · test · build' \
     -f 'enforce_admins=false' \
     -f 'required_pull_request_reviews[required_approving_review_count]=0' \
     -f 'restrictions=' 
   ```
   （`restrictions` は null 必須。`gh api` で null を送るには `-F restrictions=null` を使う。）
3. 以後、`確認した` の無い PR は main にマージ不可・deploy もされない。
4. **本パイプライン PR 自体**も最後は `確認した` を付けて自己適用でマージする。

ロールバック: `gh api -X DELETE .../branches/main/protection` と `PROD_LABEL_GATE=false`。

## 10. 生成規則（gen-staging-configs.sh）

`wrangler.free.toml` → `wrangler.staging.toml`（生成物は gitignore。SoT は生成器＋
`staging-resources.env`）:

- worker `name` → `+ -staging`（DO binding 名 `METER_DO`/`ChatRoom` 等は不変）
- service binding target → `+ -staging`（staging は staging 上流を bind）
- D1 `database_name` → `dub-core-staging` / `auth-outbox-staging`、id は staging id
- KV id → staging id、R2 `bucket_name` → `+ -staging`
- api-gateway `ALLOWED_ORIGINS` → staging fe2 origin を追記（CORS）
- `[triggers]`/`crons` → **除去**（5/5 cron 上限の回避・§3）
