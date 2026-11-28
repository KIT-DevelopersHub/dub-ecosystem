# メール送信（`resend_emails_day` / `resend_emails_month`）

[← 一覧](./README.md) ・ 無料枠（Resend Free）: **100 通/日・3,000 通/月**。超えると送信が拒否され、通知・パスワード再設定・チケット確認メールが届かなくなる。
日の枠は UTC 0 時、月の枠は月初にリセット。

## よくある原因

- 通知メール（タスク・チャット・お知らせ）を 1 件ずつ送っている
- 外形監視（canary）: `MAIL_CANARY_INTERVAL_MIN` 分ごとに 1 通（60 分なら 24 通/日）
- 失敗した送信の再送ループ・同じ宛先への重複
- 一斉送信（お知らせを全員に）

## 使っている所の調べ方

送信履歴は D1 の `mail_send_log`（mail-gateway）にある。種類別・宛先別に数える（読み取りのみ。本番で流す時は人が判断する）:

```sql
-- 今日（UTC）の送信を、送った側（サービス / ユーザー）と件名の先頭で分ける
SELECT requester, substr(subject, 1, 30) AS kind, COUNT(*) AS n
  FROM mail_send_log
 WHERE created_at >= date('now') AND status IN ('pending', 'sent')
 GROUP BY requester, kind ORDER BY n DESC LIMIT 20;

-- 同じ宛先に多く送っていないか
SELECT to_json, COUNT(*) AS n FROM mail_send_log
 WHERE created_at >= date('now') GROUP BY to_json ORDER BY n DESC LIMIT 10;
```

（`mail_send_log` は `(status, created_at, id)` のインデックスがあるので、今日の分だけを読む。）

## 対策

1. 通知はダイジェスト（1 日 1 通にまとめる）にする・アプリ内通知とプッシュを主にする
2. canary の間隔を延ばす（`services/mail-gateway/wrangler.free.toml` の `MAIL_CANARY_INTERVAL_MIN`）
3. 再送は回数の上限と間隔を付ける・同じ idempotency key で二重送信しない
4. 一斉送信は日を分ける（100 通/日を超えない）

## 課金が正しい時

- 会員が増え、通知・チケット確認だけで 1 日 100 通を超える（削ると必要なメールが届かない）
- イベントのチケット販売・当日案内など、止まると影響が大きい時期の前

**Resend Pro $20/月**: 5 万通/月、日次上限なし。5 万通を超えた分は $0.90/1,000 通の従量（10 万通/月の枠は $35/月）。
