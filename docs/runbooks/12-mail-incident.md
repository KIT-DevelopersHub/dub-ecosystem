# 10. メールが止まったとき（送信・受信・画面）

メールの監視アラート（アプリ内通知・スマホ通知・Slack の「⚠️ メールの障害: …」）を受けた時や、
「メールが届かない・送れない・画面が開かない」と言われた時の手順。

- 監視の仕組み: `services/mail-gateway/src/monitor.ts` / `src/canary.ts`（README 3.6・3.8）
- 関連: [03-oncall.md](./03-oncall.md)（初動全般）/ [01-deploy.md](./01-deploy.md#7-ロールバック)（ロールバック）

## 目次

1. [何が見張られているか](#1-何が見張られているか)
2. [最初の 5 分（切り分け）](#2-最初の-5-分切り分け)
3. [送信が止まった](#3-送信が止まった)
4. [受信が止まった](#4-受信が止まった)
5. [画面（一覧・スレッド API）が止まった](#5-画面一覧スレッド-apiが止まった)
6. [監視そのものが止まった](#6-監視そのものが止まった)
7. [ロールバック](#7-ロールバック)
8. [迂回して送る・読む（フォールバック）](#8-迂回して送る読むフォールバック)
9. [終わったら](#9-終わったら)

## 1. 何が見張られているか

| 確認 | どうやって | 間隔 | アラートまで |
|---|---|---|---|
| 送信 | 試験メール（件名 `[dub-canary] <uuid>`）を Resend で dev-monitor@（To）/ qa-b@（Cc）に送る | 60 分（`MAIL_CANARY_INTERVAL_MIN`） | 1 回失敗すると 5 分後にもう 1 通送って確かめ、2 回続けて失敗で通知 |
| 受信 | その試験メールが Email Routing → mail-gateway を通って `mail_inbound` に入ったか | 送信ごと・10 分以内（`MAIL_CANARY_DEADLINE_MIN`） | 同上（最初の失敗から 20 分前後で通知） |
| 画面の API | 監視用ユーザーとして `GET /mail/messages` と `GET /mail/threads/:id`（最後に届いた試験メールのスレッド）を呼ぶ | 15 分（`MAIL_MONITOR_INTERVAL_MIN`） | 2 回続けて失敗（30 分） |
| メンバーの送信 | 直近 60 分の `mail_send_log` で失敗が 3 件以上かつ成功以上 | 15 分 | 2 回続けて（30 分） |
| 監視の稼働 | mail-gateway の cron が監視を回しているか（`/internal/monitor/heartbeat`） | app-health-monitor が毎時 | 45 分以上止まると 2 回続けて失敗で通知 |

通知の届き方:

- **アプリ内通知**（管理者向け = 「管理者向け通知を受け取る」を持つ人。スマホにも push）
- **Slack**（`MAIL_ALERT_SLACK_WEBHOOK_URL` を入れてある時だけ）
- audit `mail.monitor.alert` / `mail.monitor.recovered`
- メールでは知らせない（壊れている経路そのものに乗るため）

1 つの障害につき「⚠️」が 1 回、直ったら「✅ 復旧しました」が 1 回。続いている間は何度も鳴らない。
通知がどこにも届かなかった時は、次の確認のたびに同じ通知を送り直す（同じ dedupKey なので二重にはならない）。

## 2. 最初の 5 分（切り分け）

1. **今の状態を見る**（管理者のログインで）
   - `GET https://dub-api-gateway.developershub-site.workers.dev/api/v1/mail/admin/monitor` — 確認ごとの最新結果（`status` / `failStreak` / `detail` / 最後に成功した時刻）
   - `GET .../api/v1/mail/admin/canary/probes?limit=10` — 試験メール 1 通ごとの結果（`sendOk` / `toOk` / `ccOk` / 遅延）
   - `GET .../api/v1/mail/status` — 送信のレート制限の状態
2. **どこが壊れたかを決める**

   | 失敗している確認 | 疑うところ | 節 |
   |---|---|---|
   | send（と send_errors） | Resend（API キー・無料枠 100 通/日・障害）、mail-gateway のデプロイ | [3](#3-送信が止まった) |
   | receive だけ | Cloudflare Email Routing のルール、mail-gateway の `email()`、D1 | [4](#4-受信が止まった) |
   | api だけ | 直前のデプロイ、identity（認可）、D1 | [5](#5-画面一覧スレッド-apiが止まった) |
   | 全部 | D1 / mail-gateway 全体 / 直前のデプロイ | [7](#7-ロールバック) |
   | 「監視の稼働」 | mail-gateway の cron が動いていない | [6](#6-監視そのものが止まった) |

3. **直前にデプロイがあったか**を見る: `gh run list --workflow deploy.yml --limit 5`。あればまず [7. ロールバック](#7-ロールバック)。
4. ログ: Cloudflare ダッシュボード → Workers → `dub-mail-gateway` → Logs（`mail monitor:` / `mail-gateway canary:` で検索）。
   手元からなら `pnpm dlx wrangler@4 tail dub-mail-gateway --format pretty`。

## 3. 送信が止まった

1. `GET /internal/health/ready`（INTERNAL。ダッシュボードのログか `wrangler tail` で readiness の issues を見る）で provider の秘密情報がそろっているか。
2. Resend ダッシュボード: API キーが生きているか / **その日の送信数が 100 通に達していないか**（試験メールで 24 通/日使う）/ Resend 側の障害（status.resend.com）。
3. probes の `sendError` が `MAIL_RATE_LIMITED` ならレート制限。待つか、[8](#8-迂回して送る読むフォールバック) の迂回を使う。
4. 送れなかったメンバーのメールは `mail_send_log` に `status='failed'` で残る（同じ Idempotency-Key で送り直すと同じ行で再送される）。

## 4. 受信が止まった

1. Cloudflare ダッシュボード → developershub.jp → **Email** → **Email Routing**:
   - ルーティングが有効か、dev-monitor@ / qa-b@ と各アドレスのルールが「Send to a Worker: dub-mail-gateway」のままか。
   - **Activity log** に試験メールが来ているか（来ていない = 送信側か MX。来て `Dropped`/`Rejected` = Worker が例外）。
2. MX / SPF の DNS が変わっていないか（Email Routing → Settings に警告が出る）。
3. Worker が例外を出している時は、ログの `email` イベントを見る。受信の保存に失敗した時も **アーカイブ転送（`MAIL_ARCHIVE_FORWARD_TO`）は行われる**ので、その間のメールは Gmail のアーカイブに残っている（[8](#8-迂回して送る読むフォールバック)）。
4. R2 を結線していれば生メール（.eml）が `dub-mail-attachments` に残る（#702 データ保全）。

## 5. 画面（一覧・スレッド API）が止まった

1. `detail` が `HTTP 403` → 監視用ユーザー（`MAIL_MONITOR_USER_ID`＝dev-monitor@）の権限が外れた（ロール管理で監視用ロールの `mail:read` / メール閲覧、ユーザーが有効かを確認）か、identity-roster の障害。
2. `HTTP 500` / 例外 → 直前のデプロイを疑い [7](#7-ロールバック)。D1 のエラーなら Cloudflare の D1 ダッシュボードで `dub-core` の状態と無料枠（rows read）を確認（usage-meter の通知も来ているはず）。
3. 「スレッドに試験メールが表示されない」→ 受信は記録されたのに画面から見えない。受信の持ち主の解決（宛先 dev-monitor@ → 名簿ユーザー）か、スコープ・一覧のクエリの退行。
4. この確認は mail-gateway の中から呼ぶので、api-gateway とフロントは含まない。画面の白画面・チャンク欠けは app-health-monitor の「メール」行（`/mail`）が別に知らせる。

## 6. 監視そのものが止まった

app-health-monitor の「メール監視の稼働 (mail-gateway cron)」が down の時。

1. Cloudflare ダッシュボード → `dub-mail-gateway` → **Triggers** に cron `*/5 * * * *` があるか。無料プランの cron 枠（5 個）を他で使い切っていないか。
2. `MAIL_MONITOR_ENABLED` が `"true"` のままか、migration `0029_mail_monitor_state.sql` が適用されているか（無いとハートビートの読み書きが失敗する）。
3. cron が動いていないと **予約送信も止まっている**。急ぎなら [7](#7-ロールバック)。

## 7. ロールバック

- Worker を直前の版へ: Cloudflare ダッシュボード → `dub-mail-gateway` → **Deployments** → 1 つ前を「Rollback」。
  手元からなら `pnpm dlx wrangler@4 rollback --name dub-mail-gateway`（`CLOUDFLARE_API_TOKEN` が別アカウント用なら `env -u CLOUDFLARE_API_TOKEN` を前に付ける）。
- D1 は forward-only。down は打たない（[01-deploy.md 7 節](./01-deploy.md#7-ロールバック)）。
- 戻したら監視の次の確認（最大 15 分）で「✅ 復旧しました」が来るのを待つ。急ぐなら canary の結果を probes で見る。
- 原因の PR は revert の PR を作ってから直す（main と本番をそろえておく）。

## 8. 迂回して送る・読む（フォールバック）

**送る**

1. 別の送信サービスに切り替える（コード変更なし）: `MAIL_OUTBOUND_PROVIDER` を `ses` か `mailchannels` にして、その秘密情報（README 3.1）を入れてデプロイ。
   **秘密情報が入っていない provider に切り替えると全部失敗する**ので、事前に入っているかを確かめる。SES は sandbox 解除済みでないと外部に届かない。
2. それもできない時は、共用の Gmail（アーカイブ転送先）から手で送る。差出人は Gmail になるので、本文に「Dub のメールが止まっているため」と一言添える。送ったものは復旧後に Dub 側に残らない点に注意。

**読む**

- 受信は `MAIL_ARCHIVE_FORWARD_TO`（共用 Gmail）にも 1 通ずつ転送されている。Dub の画面が止まっていても、ここで読める。
- 受信の保存が止まっていた間のメールは、復旧後に自動では取り込まれない。必要なものは R2 の .eml かアーカイブから確認する。

## 9. 終わったら

- 「✅ 復旧しました」が来たことを確認する（来ない = まだどこかが失敗している）。
- 発生時刻・影響（送れなかった / 届かなかった件数は `mail_send_log` の failed と Email Routing の Activity log）・原因・対処を Issue に書く。
- 誤報だった時は、しきい値（`ALERT_AFTER` / `MAIL_MONITOR_SEND_ERROR_MIN` / `MAIL_CANARY_DEADLINE_MIN`）を見直す。
