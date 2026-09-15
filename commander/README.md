# Commander

ローカルの Claude Code を駆動する、ユーザー専用の Web 司令アプリ。Web から指示を出すと
**ローカルの exec ブリッジ（daemon）が既存の Claude Code を headless で実行**し、ログを
リアルタイムに Web へストリームする。進行管理（demo→staging→本番）はフェーズ状態機械で
段飛ばし・自己承認を禁止する。Dub エコシステムの 1 アプリとして組み込む前提。

> 基盤フェーズ（本 PR）のスコープ = 疎通 PoC ＋ 意思決定 docs 初版 ＋ 状態機械コア。
> 状態機械 UI・フェーズゲート・Dub アプリ統合は次フェーズ。

## 構成

```
commander/
  daemon/   @dub/commander-daemon  ローカル exec ブリッジ (Node標準ライブラリのみ / SSE)
  web/      @dub/commander-web      最小 Web フロント (Vite + React)
  docs/     inception deck / ADR(0001-0003) / data-model / sequence
```

- **daemon はローカル専用**。Cloudflare Workers には**デプロイしない**（Claude Code は
  Workers 上で動かないため）。`127.0.0.1` にのみバインドする（ADR 0003）。
- daemon は外部ランタイム依存ゼロ。Node のネイティブ型ストリップで `.ts` を直接実行する。

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

## HTTP API（daemon）

| method | path | 説明 |
|---|---|---|
| GET | `/health` | `{ ok, service, version }` |
| POST | `/runs` | `{ prompt, cwd? }` → `{ runId, status }`（1 実行 = 1 run） |
| GET | `/runs` | run 履歴（新しい順） |
| GET | `/runs/:id` | run 詳細（バッファ済みイベント込み） |
| GET | `/runs/:id/events` | SSE。履歴を replay 後、ライブイベントを配信し、完了で close |
| GET | `/` | 組み込みテスト UI（ゼロビルド疎通用） |

## 開発（型/テスト/ビルド）

```
pnpm --filter @dub/commander-daemon typecheck
pnpm --filter @dub/commander-daemon test     # phases(状態機械) + runner(exec bridge)
pnpm --filter @dub/commander-web  typecheck
pnpm --filter @dub/commander-web  test        # App コンポーネント
pnpm --filter @dub/commander-web  build
```

## 設計ドキュメント

- `docs/00_inception_deck.md` — ビジョン・スコープ・リスク
- `docs/adr/0001-exec-bridge-local-daemon.md` — exec ブリッジ方式
- `docs/adr/0002-phase-state-machine-in-db.md` — フェーズ状態機械
- `docs/adr/0003-auth-single-operator-loopback.md` — 認証（単独運用・ループバック）
- `docs/data-model.md` — 最小スキーマ（Feature/Task/Run/RunEvent/PhaseTransition）
- `docs/sequence.md` — Web→daemon→claude→log→Web / フェーズ移行ゲート
