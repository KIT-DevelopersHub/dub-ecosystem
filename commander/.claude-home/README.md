# commander/.claude-home — Commander 専用 Claude 設定ホーム

Commander の daemon が `claude -p` を spawn するとき、この dir を `CLAUDE_CONFIG_DIR` として
渡す(`commander/daemon/src/index.ts` の既定値・`COMMANDER_CLAUDE_CONFIG_DIR` で上書き可)。
これにより spawn された Claude Code は個人の `~/.claude` ではなく**この dir**の設定を読む。

## なぜ

以前は daemon が `env: process.env` で spawn していたため、Web から呼ぶ `claude -p` が個人の
`~/.claude`(CLAUDE.md / rules / hooks / lessons = 判断キュー運用 constitution・chat-pointer
ガード等)を全部読み込み、Commander のエージェントが個人の判断キューに起票したり Stop hook を
誤発火していた。`env.ts` の `buildSpawnEnv` が最小 env + `CLAUDE_CONFIG_DIR` をこの dir に
向けることで、その継承を構造的に断つ。

## 中身(すべて個人 config からの複製・移動ではない)

- `CLAUDE.md` — Commander の開発規約(Core Principles / PREP / 開発フロー要点 / 自己承認禁止 /
  UI 規約 / 検証)。
- `rules/dub-development-flow.md` — Dub 開発フローの **dev 部分のみ**(フェーズ排他・1 機能 1
  エントリ・demo/staging・verify:live・確認カード規約・自己承認禁止)。
- `rules/review-and-workflow.md` — 開発の進め方・多角レビュー・サブエージェント運用の dev 部分。
- `lessons/dev-lessons.md` — 個人 memory の dev 部分のみ(実ブラウザ E2E / verify:live /
  design-system / 楽観的 UI / スケルトン / 並行開発の安全 / 自己承認禁止 等)。
- `settings.json` — **hooks は空**(個人 hooks を一切継承しない)。

## 含めていないもの(意図的除外)

判断キュー/起票運用(coroutine 判断・_close.sh・出力ボード・operating-constitution・
chat-pointer ガード・送る/定例)、および開発に無関係な個人事項(学業・就活・カレンダー・メール・
個人 PII・他プロダクト固有の秘書運用)。

> 個人の `~/.claude` は**一切変更していない**(この dir へコピーしただけ)。
