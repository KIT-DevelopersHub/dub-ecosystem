# app-health-monitor — アプリ単位の死活監視

先日の「something went wrong (stale chunk)」障害（デプロイが index.html を配ったが一部のハッシュ付き JS チャンクが 404 になり、その画面へ遷移すると白画面）を **人手を介さず毎時検知**する Worker。

## 何を確認するか（監視対象）

**フロントエンド（fe2-app-shell = 単一 SPA・公開 HTTP）** — アプリ単位の行:
home / events / tasks / gantt / notifications / chat / mail / usage / members / driveshare / roles。
各行の健全性 = (a) ルートを GET → 200 かつ本体に `id="root"`（SPA fallback が実体 HTML を返す）+ (b) ビルド時 emit の `/app-health.json`（全 JS/CSS チャンク一覧）を掃引し**各チャンクが 200 で実在**（1つでも 404 → 全アプリ行が down = stale chunk 障害を捕捉）。

**バックエンド（Service Binding 経由 /health・gateway のみ公開 /healthz）**:
api-gateway, identity-roster, auth-service, event-service, task-service, gantt-service, notification, mail-gateway, chat-service, member-service, usage-meter, file-meta, audit-log, deploy-service, drive-share-service, drive-proxy, github-sync, webhook-ingest。

判定方法・チャンク一覧の詳細は `src/config.ts`。`app-health.json` は `apps/fe2-app-shell/vite-plugin-app-health.ts` が `vite build` 時に出力。

## 毎時ポーリング（無料枠厳守・Cron 不使用）

Workers Free の **5 cron 枠は業務 cron で満杯**のため、リポジトリ標準の代替 = **SQLite-backed Durable Object アラーム**（`MonitorDO`・cron 枠を消費しない。usage-meter / freeq-drain と同方式）で **毎時**自己再スケジュール。`POST /internal/monitor/kick` で1度 arm すれば以後自走。

## 失敗時 admin 通知 + フラッピング抑制

- notification-service `POST /notify`（内部）で `recipientRoles=[role_sys_admin, role_sys_maintainer]` / `type=ops.health` / `channels=[in_app]`。admin/maintainer の inbox にのみ届く（一般メンバーには出ない・usage-meter と同一方式）。
- **連続 2 回失敗**で down 通知（単発ブリップは無視）→ 復旧で解消通知。`dedupKey=health:{down,up}:<id>:<downSince>` で重複ゼロ。
- 記録: dub-core D1 `monitor_status`（最新状態）+ `monitor_incident`（遷移ログ）。`GET /internal/monitor/status` で参照。

## HTTP surface

| method path | 用途 | ゲート |
|---|---|---|
| GET /internal/health | liveness | 公開 |
| POST /internal/monitor/kick | 毎時アラームを arm | x-monitor-token（公開 origin なので token のみ） |
| POST /internal/monitor/run | 1巡を即実行（`?inject=down`/`?inject=up` で合成 target） | 同上 |
| GET /internal/monitor/status | 最新スナップショット | 同上 |

## デプロイ

`infra/deploy/deploy-prod.sh` の最後にデプロイ（全 upstream を bind するため）。D1 は `db/0001_monitor.sql` を dub-core に1度適用。`MONITOR_ADMIN_TOKEN` シークレットを入れると deploy 後に自動 arm。詳細は `wrangler.free.toml` 冒頭。

## わざと NG にして通知を実証する

```
# down（存在しないチャンクを模擬）を2回 → admin に down 通知が飛ぶ
curl -X POST -H "x-monitor-token: $TOK" ".../internal/monitor/run?inject=down"
curl -X POST -H "x-monitor-token: $TOK" ".../internal/monitor/run?inject=down"
# 復旧 → 解消通知
curl -X POST -H "x-monitor-token: $TOK" ".../internal/monitor/run?inject=up"
```

オフラインでは同経路を結合テスト（`test/cycle.test.ts` / `test/notify.test.ts` / `test/checks.test.ts`）で実証済み（23 tests green）。
