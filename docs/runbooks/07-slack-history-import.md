# Slack 履歴インポート Runbook（Slack → fe6-chat D1 移行）

結論: カンファ運営の指定 Slack チャンネル（公開＋プライベート）の履歴を、chat-service の公開
API を経由せず **dub-core D1 へ直接 INSERT するオフライン専用インポーター**で移行する（方式A =
Slack Web API）。**手順のみ。実移行（本番 D1 書込・R2 アップロード）はトークン／対象チャンネル
リスト到着後、ユーザー許可を得てから実行する**（`--apply` は実装済みだが、このドキュメント自体は
実行しない — `~/.claude/rules/dub-development-flow.md` §5 のフェーズゲート）。

## 目次

- [1. 実装の所在](#1-実装の所在)
- [2. マッピング](#2-マッピング)
- [3. 冪等性（処理済み ts レジャー）](#3-冪等性処理済み-ts-レジャー)
- [4. 必要なもの（トークン scope・対象チャンネル）](#4-必要なものトークン-scope対象チャンネル)
- [5. パイロット手順（dry-run → 1 チャンネル実移行）](#5-パイロット手順dry-run--1-チャンネル実移行)
- [6. D1 無料枠対策（バッチ分割）](#6-d1-無料枠対策バッチ分割)
- [7. 未マッピングユーザーの扱い](#7-未マッピングユーザーの扱い)

## 1. 実装の所在

| ファイル | 役割 |
|---|---|
| `infra/d1/src/slackImport.ts` | 純粋関数層。Slack API 形状の型、user/channel/message/reaction/attachment → dub 行マッピング、Slack mrkdwn → dub Markdown-subset 変換、`INSERT OR IGNORE` SQL 生成、処理済み ts レジャー、バッチ分割。ネットワーク／ファイルI/O無し = フルユニットテスト対象。 |
| `infra/d1/src/slackClient.ts` | Slack Web API クライアント（`conversations.list/history/replies`・`users.list`・ファイルDL）。ページネーション + 429 レート制限リトライ（`Retry-After` 優先、無ければ指数バックオフ）。 |
| `infra/d1/src/slackFixtureSource.ts` | オフライン `SlackSource`。`infra/d1/fixtures/slack/*.json` を読み、Slack API を叩かず同じパイプラインを検証する（dry-run の実体）。 |
| `infra/d1/src/slackImportRun.ts` | オーケストレーション。`SlackSource`（live/fixture 共通インターフェース）+ identity_users export + レジャーを結線し、順序付き SQL 文字列配列を生成。 |
| `infra/d1/scripts/slack-import.ts` | CLI 本体。`--fixture-dir`（オフライン dry-run）/ `--channels`（本番、要 `SLACK_BOT_TOKEN`）。既定はプレビュー（何も書き込まない）。`--apply`（+ `CLOUDFLARE_API_TOKEN`）で初めて実書込。 |
| `infra/d1/fixtures/slack/*.json` | パイロット用サンプル（公開ch 1 + プライベートch 1、スレッド・リアクション・添付・未マッピングユーザーを網羅）。詳細は同ディレクトリの README。 |
| `infra/d1/test/slackImport.test.ts` / `slackClient.test.ts` / `slackImportRun.test.ts` | ユニット + 実スキーマ適用（`migratedD1()`）+ 冪等性テスト。 |

chat-service の公開 API（`postMessage` 等）は経由しない — 通知の暴発・楽観ロック衝突・無料枠
（Queue/Worker 呼び出し）圧迫を避けるため。

## 2. マッピング

| Slack | dub-core D1 | 備考 |
|---|---|---|
| `users.list` の `profile.email` | `identity_users.id`（email 突合） | email 一致なしは「未マッピング」扱い（§7）。 |
| `conversations.list` の channel | `chat_channels`（`type='topic'`, `visibility`=`is_private`で分岐） | `event_id`/`dm_key` は NULL（イベント関連付け・DM は対象外）。 |
| message（`ts`） | `chat_messages.id = msg_<ulid(slackTsをms化)>` | `packages/db/src/ids.ts` の `ulid(now)` を **Slack の元 ts** で呼ぶことで、後から挿入しても `id DESC`（実インデックス）で真の時系列になる。 |
| `thread_ts` | `thread_root_id` | 2パス: (1) チャンネル内の全メッセージ（root+reply）を先にIDミント → (2) `thread_ts !== ts` のメッセージだけレジャー参照で root の dub id を解決。 |
| `reactions[].name`（shortcode） | `chat_reactions.emoji`（unicode） | fe6-chat はUnicode絵文字をそのまま描画するため変換必須。`SLACK_SHORTCODE_TO_EMOJI` にある主要リアクションのみ移行、未知shortcodeはスキップ（件数はsummaryに出る）。 |
| `files[]` | `file_meta_files`(source=R2) + `file_meta_links`(target_type='message') | R2バケット `dub-file-attachments`（既存, file-meta所有）。キーは `slack-import/<channelId>/<ts>/<fileId>-<name>`（Slack ID起点で決定的 = 再アップロード事故を防ぐ）。 |
| Slack mrkdwn body | dub Markdown-subset body | `*bold* _italic_ ~strike~ `code`` `>` blockquote は共通そのまま。`<@U…>`→`<@dubUserId>`（未マッピングは `@表示名` プレーンテキスト）、`<#C…\|name>`→`#name`、`<!here>`等→`@here`等、`<url\|label>`→`[label](url)`、`&amp;/&lt;/&gt;`をデコード。 |

## 3. 冪等性（処理済み ts レジャー）

`newId`/`ulid` はランダムサフィックスを含むため、同じメッセージを毎回同じIDで再ミントすること
はできない。そこで **レジャー（`channelId:ts` → 発行済み dub id の対応表）を実際の冪等性の
根拠**にする：

- 初回: レジャーに無い ts → 新規ミント → レジャーに記録 → INSERTを生成。
- 再実行: レジャーにある ts → 既存IDを再利用し、**その行のINSERTは生成すらしない**（`summary.alreadyImportedMessages` でカウント）。
- 生成されたSQL自体も全て `INSERT OR IGNORE`（`infra/d1/src/adminNotify.ts` と同じ流儀）— レジャーファイルを万一失っても、同じ `.sql` を再適用するだけなら重複しない（二重の安全網）。

レジャーはCLIが `--ledger`（既定 `infra/d1/.slack-import/ledger.json`、`.gitignore`済み）に
JSONで永続化し、次回実行時に読み込む。**このファイルは移行の実体そのもの**なので、実移行後は
DubVault等バックアップ推奨（削除すると次回実行が全件再スキャン=時間はかかるが二重挿入はしない）。

## 4. 必要なもの（トークン scope・対象チャンネル）

**現時点で未着手（このPRの対象外）:**

| 項目 | 内容 |
|---|---|
| Slack Bot Token（`xoxb-...`） | scope: `channels:read` `groups:read` `channels:history` `groups:history` `users:read` `users:read.email` `files:read` |
| Bot をプライベートチャンネルへ招待 | `groups:history` は **botがinviteされているチャンネルのみ**履歴を返す。対象プライベートch全てに事前招待が必要。 |
| 対象チャンネルIDリスト | カンファ関連の公開chID + プライベートchID（`--channels C1,C2,...`）。 |
| （任意）identity_users export | 本番D1から `SELECT id, email FROM identity_users` を都度取得も可（`CLOUDFLARE_API_TOKEN` があれば自動）。 |

トークンは環境変数 `SLACK_BOT_TOKEN`（ローカル/DubVault保管、コミットしない）で渡す。

## 5. パイロット手順（dry-run → 1 チャンネル実移行）

1. **オフライン dry-run（今すぐ実行可能・トークン不要）**:
   ```bash
   pnpm --filter @dub/infra-d1 slack:import -- \
     --fixture-dir infra/d1/fixtures/slack \
     --identity-export infra/d1/fixtures/slack/identity-users.json \
     --system-user-id usr_system0000000000000001
   ```
   出力される `# total SQL statements` 等のサマリーとバッチ `.sql` を確認する。
2. **トークン到着後、小規模チャンネル1本でライブpreview**（まだ書き込まない）:
   ```bash
   SLACK_BOT_TOKEN=xoxb-... pnpm --filter @dub/infra-d1 slack:import -- \
     --channels C_PILOT_CHANNEL --system-user-id usr_system...
   ```
   `--identity-export` を省略すると `CLOUDFLARE_API_TOKEN` があれば本番 identity_users を自動取得。
3. 生成された `.sql` バッチをレビュー（本文の変換結果・未マッピング件数・添付件数を確認）。
4. **ユーザー許可を得てから** `--apply` を追加（+ `CLOUDFLARE_API_TOKEN`）して実書込。
5. fe6-chat 上で当該チャンネルを実ブラウザ確認（スレッド・リアクション・添付・メンションが正しく出るか）。
6. 問題なければ残り全チャンネルを `--channels` にまとめて実行（レジャーがあるので既に入れた分は再挿入されない）。

## 6. D1 無料枠対策（バッチ分割）

`batchStatements()` が既定200文単位で `.sql` を分割し、CLIは1バッチ=1回の
`wrangler d1 execute --file` 呼び出しにする（`--batch-size`で調整可）。実行前にCLI出力の
`# total SQL statements` / `# batches of N: M` で件数見積りを確認できる。

## 7. 未マッピングユーザーの扱い

Slackユーザーの email が現行 `identity_users` に無い場合（退職者・外部ゲスト・Slack Bot）:

- **既定（`embed-name`）**: メッセージは`kind='user'`のまま`author_id=NULL`でインポートし、本文
  先頭に `[Slack: <表示名>] ` を付与 — 発言内容と話者名は失わないが、実アカウントには紐付かない
  （チャットUI上は「誰でもない発言」として表示される）。
- **`--unmapped-policy skip-message`**: そのメッセージ自体をインポートしない
  （そのメッセージがスレッドrootだった場合、返信は「rootの無いスレッド」= `thread_root_id`が
  解決できずNULLになる — 既定のembed-nameを推奨する理由）。
- リアクションは未マッピングユーザー分は個別にドロップ（`author_id`必須の`chat_reactions`制約のため）。
