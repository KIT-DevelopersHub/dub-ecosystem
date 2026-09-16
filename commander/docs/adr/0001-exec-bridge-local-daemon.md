# 0001. 実行エンジンはローカル daemon 経由で既存 Claude Code を spawn する

- Status: Accepted
- Date: 2026-09-16
- Deciders: 高岡己太朗 (owner)

## Context

Commander は「Web から指示 → ローカルの Claude Code が実装」を実現する。Claude Code は
Cloudflare Workers（Dub のホスティング）上では動かせない。また実行エンジンは自作せず、
**既存のローカル Claude Code をそのまま使う**方針（置き換えない）。フロントとエンジンの間を
どうつなぐかを決める。

## Decision

**ローカル常駐 exec ブリッジ（Node/TS daemon）** を置き、それが `claude` を headless で spawn する。

- 起動コマンド: `claude -p "<prompt>" --output-format stream-json --verbose`
- daemon は stdout を **行単位の JSON（stream-json）** としてパースし、各オブジェクトを
  run イベントに変換して **SSE** で Web フロントへ中継する。
- 1 HTTP リクエスト = 1 `Run` = 1 `claude -p` 実行。run とイベントは daemon 内にバッファし、
  遅れて接続した購読者にも履歴を replay する。
- トランスポートは **SSE**（ログは一方向ストリームで足りる）。将来双方向が要れば WS を追加。
- daemon は **Node 標準ライブラリのみ**（`node:http` + SSE）で実装し、外部ランタイム依存を持たない。
  TypeScript は Node のネイティブ型ストリップ（`node --experimental-strip-types`）で直接実行する。

## Alternatives Considered

1. **フロントから直接 claude を叩く** — 不可。Workers 上でプロセス spawn はできない。
2. **Claude Agent SDK をサーバに組み込み自前エンジン化** — 「既存 Claude Code をそのまま使う」
   方針に反する。二重メンテになる。
3. **WebSocket 常時接続** — ログ中継は一方向で足り、SSE の方が実装・運用が軽い。双方向要件が
   出た時点で追加する。
4. **重い常駐サービス（PM2 等で自動起動）** — 非力 PC 制約に反する。手動起動に留める。

## Consequences

- (+) 実行エンジンは既存 Claude Code のまま。挙動・認証・権限はユーザーの既存設定を再利用。
- (+) daemon は依存ゼロで軽量。起動が速く、`pnpm install` 不要でも `node` だけで動く。
- (+) SSE により標準的な `EventSource` でフロントが購読でき、curl でも疎通検証できる。
- (−) ローカル daemon の手動起動が必要（SaaS 化はできない）。単独運用なので許容。
- (−) TS の一部構文（parameter properties・enum・namespace）はネイティブ型ストリップで使えない。
  daemon の src では使わない（テスト・フロントは vite/esbuild 経由なので制約なし）。
- 実測: 疎通 PoC で `POST /runs` → SSE → `claude -p` 実行 → stream-json 中継 → exit 0 →
  status `succeeded` をローカルで確認済み。
