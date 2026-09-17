# Commander

ローカルの Claude Code を駆動する、ユーザー専用の Web 司令アプリ。Web から指示を出すと
**ローカルの exec ブリッジ（daemon）が既存の Claude Code を headless で実行**し、ログを
リアルタイムに Web へストリームする。進行管理（demo→staging→本番）はフェーズ状態機械で
段飛ばし・自己承認を禁止する。Dub エコシステムの 1 アプリとして組み込む前提。

> フェーズ2 = フェーズ状態機械の **D1 永続化** ＋ **フェーズゲート API/UI**。
> フェーズ3（本 PR）= **Dub アプリランチャー統合**（`/commander`・管理者限定/メンバー未公開）＋
> **daemon 堅牢化**（run の cancel / timeout・共有トークン認証）＋ **run 永続化配線**
> （daemon → commander-service → `commander_runs`/`commander_run_events`）。

## 構成

```
commander/
  daemon/   @dub/commander-daemon  ローカル exec ブリッジ (Node標準ライブラリのみ / SSE)
  web/      @dub/commander-web      Web フロント (Vite + React) — 実行コンソール ＋ フェーズ管理
  docs/     inception deck / ADR(0001-0004) / data-model / sequence
apps/fe2-app-shell/
  src/features/commander/  Dub アプリランチャー統合（/commander・管理者限定/メンバー未公開）。
                           @dub/commander-web の CommanderConsole/FeatureBoard を再利用（ロジック非重複）
packages/
  commander-phases/  @dub/commander-phases  フェーズ FSM の単一の真実（純粋・依存ゼロ）
services/
  commander-service/ @dub/commander-service フェーズゲート API（Hono / dub-core D1 commander_ ns）
infra/d1/migrations/commander/  additive migration（commander_ テーブル群）
```

- **daemon はローカル専用**。Cloudflare Workers には**デプロイしない**（Claude Code は
  Workers 上で動かないため）。`127.0.0.1` にのみバインドする（ADR 0003）。
- **フェーズの状態は共有 D1 `dub-core` の `commander_` 名前空間に永続化**する。CRUD と
  遷移ゲート（段飛ばし=409・自己承認=403）は `commander-service` ワーカーが担う（ADR 0004）。
- 遷移表は `@dub/commander-phases` に集約（daemon とワーカーが共有・二重定義禁止）。daemon の
  `phases.ts` は re-export のみ。そのため daemon の `start`（raw node）実行前にこのパッケージの
  build が必要（`pnpm --filter @dub/commander-phases build`、通常は turbo が自動）。

## 前提

- Node >= 22（ネイティブ TypeScript 型ストリップ利用）
- `claude` CLI が PATH にある（既存のローカル Claude Code をそのまま使う）

## 起動手順（ローカル・手動）

非力 PC 制約のため常駐・自動起動はしない。使うときだけ手動で起動する。

### 1) exec ブリッジ（daemon）

```
# リポジトリルートから
node --experimental-strip-types commander/daemon/src/index.ts
# => [commander-daemon 0.1.0] listening on http://127.0.0.1:4319
```

環境変数（任意）:

| 変数 | 既定 | 意味 |
|---|---|---|
| `COMMANDER_PORT` | `4319` | 待ち受けポート |
| `COMMANDER_CLAUDE_BIN` | `claude` | claude バイナリのパス |
| `COMMANDER_CWD` | `process.cwd()` | spawn する claude の作業ディレクトリ |
| `COMMANDER_CLAUDE_ARGS` | (空) | claude へ渡す追加引数（スペース区切り。例 `--model sonnet`） |
| `COMMANDER_OPERATOR_TOKEN` | (空) | 共有トークン。設定すると `/health`・`/` 以外の全ルートで必須（`Authorization: Bearer <token>`、SSE は `?token=`）。未設定なら開放（単独ループバック） |
| `COMMANDER_RUN_IDLE_TIMEOUT_MS` | `1800000` | 無音（stream-json の進捗が途切れた）が続いたら kill→failed する idle watchdog。進捗が来るたびリセットするので稼働中の run は殺さない。既定 30 分。`0` で無効 |
| `COMMANDER_RUN_TIMEOUT_MS` | `7200000` | 1 run のハード上限（活動に関係なくこの時間で kill→failed する保険。リセットしない）。既定 2 時間。`0` で無効 |
| `COMMANDER_SERVICE_URL` | (空) | 設定すると run と各イベントを commander-service に永続化（best-effort） |
| `COMMANDER_SERVICE_TOKEN` | (空) | commander-service へ送る `x-commander-token` |
| `COMMANDER_ISOLATE_ENV` | `1`（有効） | env 分離。`0`/`false` で無効化（親 env を丸ごと継承） |
| `COMMANDER_CLAUDE_CONFIG_DIR` | `commander/.claude-home` | spawn する claude の `CLAUDE_CONFIG_DIR` |

### env 分離（個人 `~/.claude` を読ませない）

daemon は `claude -p` を spawn するとき、`env: process.env` を丸コピーせず **最小 allow-list な
env** を作り、`CLAUDE_CONFIG_DIR` を **Commander 専用の設定ホーム `commander/.claude-home`** に
向ける（`daemon/src/env.ts` の `buildSpawnEnv`）。これにより spawn された Claude Code は個人の
`~/.claude`（CLAUDE.md/rules/hooks/lessons = 判断キュー運用 constitution 等）を**読まない**。
`commander/.claude-home/` には dev に必要なノウハウだけを複製した CLAUDE.md/rules/lessons と
**hooks 空**の settings.json を置く（詳細は `commander/.claude-home/README.md`）。
`COMMANDER_ISOLATE_ENV=0` で従来挙動（親 env 継承）に戻せるが、その場合も CLAUDE_CONFIG_DIR は
リダイレクトされる。

ブラウザ不要の最短確認: `http://127.0.0.1:4319/` に**組み込みテスト UI**が出る。
プロンプトを入れて Run するとログがストリーム表示される。

curl での疎通確認:

```
curl -s http://127.0.0.1:4319/health
RUN=$(curl -s -XPOST http://127.0.0.1:4319/runs -H 'content-type: application/json' \
  -d '{"prompt":"Reply with the single word: PONG"}' | sed -n 's/.*"runId":"\([^"]*\)".*/\1/p')
curl -sN http://127.0.0.1:4319/runs/$RUN/events
```

### 2) Web フロント（別ターミナル）

```
pnpm --filter @dub/commander-web dev
# => http://localhost:5609
```

daemon のアドレスを変えた場合は `VITE_COMMANDER_DAEMON` で上書き（既定 `http://127.0.0.1:4319`）。
フェーズゲート API のアドレスは `VITE_COMMANDER_API` で上書き（既定 `http://127.0.0.1:8787`）。

### 3) フェーズゲート API（commander-service・任意）

フェーズ管理 UI を動かすときだけ起動する（実 D1 が要る）。

```
# ローカル D1 にスキーマ適用（冪等・集約マイグレーション経由）
pnpm db:migrate
# ワーカー起動（miniflare のローカル D1 を使用）
pnpm --filter @dub/commander-service exec wrangler dev
# => http://127.0.0.1:8787
```

## HTTP API（daemon）

| method | path | 説明 |
|---|---|---|
| GET | `/health` | `{ ok, service, version }` |
| POST | `/runs` | `{ prompt, cwd? }` → `{ runId, status }`（1 実行 = 1 run） |
| GET | `/runs` | run 履歴（新しい順） |
| GET | `/runs/:id` | run 詳細（バッファ済みイベント込み） |
| DELETE | `/runs/:id` | 実行中の run を cancel（child を SIGTERM → failed）。202 / 404 |
| GET | `/runs/:id/events` | SSE。履歴を replay 後、ライブイベントを配信し、完了で close |
| GET | `/` | 組み込みテスト UI（ゼロビルド疎通用） |

`COMMANDER_OPERATOR_TOKEN` 設定時は `/health`・`/` 以外で共有トークン必須。cancel / timeout で
killされた run は `failed`（理由を error イベントで先出し）。`COMMANDER_SERVICE_URL` 設定時は run と
各イベントを commander-service に best-effort で永続化する（失敗しても run は止めない）。

## HTTP API（commander-service・フェーズゲート）

| method | path | 説明 |
|---|---|---|
| GET | `/health` | `{ ok, service, version }` |
| GET | `/features` | 機能一覧（新しい順） |
| POST | `/features` | `{ title, ledgerRef? }` → 新規機能（`demo_building` で開始） |
| GET | `/features/:id` | `{ feature, allowedTransitions, transitions }`（次に進める辺＋監査履歴） |
| POST | `/features/:id/transition` | `{ to, approvedByUser?, note? }`。段飛ばし=**409**・自己承認=**403** |
| GET/POST | `/features/:id/tasks` | 機能配下タスクの一覧/作成（最小） |
| GET/POST | `/runs` | run 一覧 / 作成（`{ id?, prompt, cwd, status? }`）。daemon が永続化に使う |
| GET | `/runs/:id` | run 詳細（`{ run, events }`） |
| GET/POST | `/runs/:id/events` | run イベントの一覧 / 追記（`{ type, payload?, at? }`）。status/exit は run 行に畳み込む |

`COMMANDER_OPERATOR_TOKEN`（任意）を設定すると、POST 系は `x-commander-token` ヘッダ一致を要求
（未設定なら開放。共有トークン認証の本実装は次フェーズ）。

## 開発（型/テスト/ビルド）

```
pnpm --filter @dub/commander-phases  test      # フェーズ FSM（happy/段飛ばし/未承認/終端）
pnpm --filter @dub/commander-service test      # フェーズゲート API（409/403 を実 SQLite で実測）
pnpm --filter @dub/commander-daemon  test      # phases(re-export) + runner(exec bridge)
pnpm --filter @dub/commander-web     test      # 実行コンソール ＋ フェーズ管理 UI
pnpm --filter @dub/commander-web     build
```

## 設計ドキュメント

- `docs/00_inception_deck.md` — ビジョン・スコープ・リスク
- `docs/adr/0001-exec-bridge-local-daemon.md` — exec ブリッジ方式
- `docs/adr/0002-phase-state-machine-in-db.md` — フェーズ状態機械
- `docs/adr/0003-auth-single-operator-loopback.md` — 認証（単独運用・ループバック）
- `docs/adr/0004-persist-phase-fsm-in-dub-core.md` — FSM の dub-core 永続化 ＋ commander-service
- `docs/data-model.md` — 最小スキーマ（Feature/Task/Run/RunEvent/PhaseTransition）
- `docs/sequence.md` — Web→daemon→claude→log→Web / フェーズ移行ゲート
