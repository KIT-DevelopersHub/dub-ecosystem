# Slack 履歴インポート Runbook（Slack → fe6-chat D1 移行）

結論: 指定した Slack チャンネルの履歴を、**同じ名前の新しい Dub チャンネル**として dub-core D1 へ
直接 INSERT するオフライン専用インポーター（chat-service の公開 API は経由しない＝通知の暴発・
無料枠圧迫を避ける）。Slack 側は旧 LMB の Slack アプリ（bot）を再インストールして使う。
**実移行（本番 D1 書込・R2 アップロード）はオーナーの明示許可を得てから `--apply` で行う。**

## 1. 何が取り込まれるか

| Slack | Dub | 備考 |
|---|---|---|
| チャンネル | `chat_channels`（同名・新規作成、公開/非公開を維持） | ID は Slack チャンネル ID から決定的に生成。再実行しても同じチャンネル。アーカイブ済みは archived で作成。 |
| メンバー | `chat_channel_members` | Dub アカウントがある人だけ（作成者は admin）。非公開チャンネルはここに居る人だけが見られる。 |
| 投稿者 | `identity_users`（email 突合） | 突合できない人（退職者・ゲスト）と bot は **停止状態（`status='disabled'`）の仮ユーザー**を作る。bot は表示名に `(bot)`。ログイン不可・メンション候補にも出ない。 |
| メッセージ | `chat_messages` | 本文は Slack mrkdwn → Dub 記法に変換。編集日時も保持。参加/退出は system 行。bot の添付カード本文は引用として残す。 |
| スレッド | `thread_root_id` | 全返信を取得。親が見えない返信（無料プランの 90 日外）は通常メッセージとして表示。 |
| リアクション | `chat_reactions` | **全件**。標準絵文字は Unicode に、スキントーン対応、カスタム絵文字は `:name:` の文字で保持。 |
| ピン留め | `chat_pins` | |
| ブックマーク | ピン留めされた system メッセージ 1 件 | Dub にブックマーク欄が無いため、リンク一覧として先頭にピン留め。再実行で内容を更新。 |
| 添付ファイル | R2 `dub-file-attachments` + `file_meta_files` / `file_meta_links` | Slack 側で削除済み・無料プランで非表示のものは件数だけ数えてスキップ。 |

取り込まないもの（2 回目以降の候補）: カスタム絵文字の画像、Canvas、DM、ブックマークのフォルダ。

## 2. 無料プランの制約

Slack 無料プランは **直近 90 日分**のメッセージ・ファイルしか API で返さない。インポーターは
見える範囲をそのまま取り込む（設定不要）。古い分が必要になったら有料化 or Slack 標準
エクスポートからの取り込みを別途検討する。

## 3. 冪等性

すべての ID（チャンネル・メッセージ・ファイル・仮ユーザー）を **Slack 側 ID のハッシュから決定的に
生成**し、SQL は `INSERT OR IGNORE`。途中で失敗しても、何度再実行しても重複しない。
ローカルの状態ファイルは不要。新しい投稿が増えた後に再実行すれば差分だけが入る。

## 4. 準備（LMB アプリの再インストール）

1. [Slack API: Your Apps](https://api.slack.com/apps) で旧 LMB アプリを開く。
2. OAuth & Permissions の Bot Token Scopes に次を追加:
   `channels:read` `groups:read` `channels:history` `groups:history` `channels:join`
   `users:read` `users:read.email` `files:read` `bookmarks:read` `emoji:read`
   (`emoji:read` はカスタム絵文字の取り込み(5c)用。チャンネル取り込みだけなら不要)
3. ワークスペースに再インストールし、Bot User OAuth Token（`xoxb-...`）を控える（コミットしない）。
4. 取り込みたい**非公開**チャンネルで `/invite @<LMBアプリ名>`（公開チャンネルは自動で参加する）。

## 5. 実行手順

```bash
# 1. offline dry-run (no token)
pnpm --filter @dub/infra-d1 slack:import \
  --fixture-dir fixtures/slack --identity-export fixtures/slack/identity-users.json \
  --org-id org_fixture --system-user-id usr_system0000000000000001

# 2. live preview (writes nothing; SQL goes to --out)
SLACK_BOT_TOKEN=xoxb-... CLOUDFLARE_API_TOKEN=... pnpm --filter @dub/infra-d1 slack:import \
  --channels general,conference-core --system-user-id usr_... --out /tmp/slack-preview

# 3. after owner approval: same command + --apply
```

- `--channels` はチャンネル名（`#` 有無どちらでも）か ID のカンマ区切り。
- `--identity-export` を省略すると本番 `identity_users`（id, email, org_id）を wrangler で取得する。
- `--no-attachments` でファイルを後回しにできる。`--batch-size`（既定 200 文）で D1 への 1 回の量を調整。
- 実行後、fe6-chat で該当チャンネルを実ブラウザ確認（スレッド・リアクション・添付・ピン・作者名）。

## 5b. アプリ内取り込み(fe6-chat 「チャンネル取り込み」)

ロール管理 > チャット > 細かい権限「Slack から取り込み」(`chat:slack_import`・既定は admin のみ ON)を持つ人が
画面からチャンネル名を選ぶと、chat-service の **再開可能なステップ式ジョブ**が上と同じ内容を取り込む。

- 有効化(オーナー許可後・staging から): `SLACK_BOT_TOKEN` を chat-service の Worker Secret に設定し、
  `infra/d1/migrations/chat/0005_slack_import_jobs.sql` と `identity/0021_chat_slack_import_perm.sql` を dub-core に 1 回適用。未設定なら API は 412。
- ブラウザが `POST /chat/slack-import/jobs/:id/step` を繰り返す(1 ステップ = 無料枠内の小さな仕事 +
  1 回の D1 batch)。タブを閉じても次に開いた時に続きから再開。Slack 429 は `retryAfterMs` 待ちで再開。
- 失敗したジョブは同じチャンネルで再度「取り込み」を押すと続きから再開。完了済みを押すと差分取り込み。
- 20MB 超・DL 不可のファイルは件数だけ数えて添付行を作らない。

## 5c. カスタム絵文字の取り込み(fe6-chat 絵文字ピッカー「カスタム」)

ロール管理 > チャット > 細かい権限「Slack の絵文字を取り込み」(`chat:emoji_import`・既定は admin のみ ON)を
持つ人がピッカーの「Slack の絵文字を取り込む」を押すと、`emoji.list` の画像を R2(`dub-file-attachments` の
`custom-emoji/<name>`)へ**原寸・原形式のまま**保存し `chat_custom_emojis` に登録する。

- 有効化: Bot Token に `emoji:read` を追加して再インストール。`infra/d1/migrations/chat/0006_custom_emojis.sql` と
  `identity/0023_chat_emoji_import_perm.sql` を dub-core に 1 回適用。
- `POST /chat/custom-emojis/slack-import {after}` を画面が繰り返す(1 回 = 最大 20 枚 DL + 1 回の D1 batch)。
  既存名はスキップ(冪等)。alias は画像を持たず `alias_of` で解決。標準絵文字への alias は対象外。
- 取り込み済みのリアクション `:name:` は、同名のカスタム絵文字があれば自動で画像表示になる。

## 6. 実装の所在

| ファイル | 役割 |
|---|---|
| `services/chat-service/src/slack-import.ts` | アプリ内取り込みのステップエンジン(ルートは `app.ts`、認可は `policy-table.ts`) |
| `packages/slack-import/src/mapping.ts` | 純粋関数層（型・決定的 ID・本文変換・絵文字・行/SQL 生成） |
| `packages/slack-import/src/run.ts` | CLI 用の取得と順序付け（仮ユーザー → チャンネル → メッセージ） |
| `packages/slack-import/src/client.ts` | Slack Web API（ページネーション・429 リトライ・join・ファイル DL・emoji.list） |
| `services/chat-service/src/custom-emoji.ts` + `packages/slack-import/src/emoji.ts` | カスタム絵文字の取り込み・一覧・画像配信 |
| `infra/d1/src/slackFixtureSource.ts` + `infra/d1/fixtures/slack/` | オフライン dry-run 用 |
| `infra/d1/scripts/slack-import.ts` | CLI |
