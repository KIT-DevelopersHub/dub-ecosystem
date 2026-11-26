# 11 — 無料枠が上限に近づいた時（対策するか、課金するか）

> 結論: Dub は Cloudflare などの**無料枠で $0 運用**している。無料枠は上限で**止まる**（勝手に課金はされない）。
> 上限に近づいたら、項目ごとの手順書で**使っている所を特定して対策する**か、**人が課金を決める**。
> 課金は必ず人が決める。自動でプランを上げる仕組みはない。

## 流れ

1. **計る**: usage-meter が毎日（と `/usage` を開いた時）使用量を `usage_snapshot` に記録する。
2. **段階を付ける**（`services/usage-meter/src/escalation.ts`）

   | 段階 | 条件 | やること | Issue |
   |---|---|---|---|
   | 注意 `warn` | 70% 以上、または今のペースだとリセット前に 100% に届く | 内訳を見て、増えた理由を確かめる | P1 |
   | 対策 `act` | 85% 以上、またはストレージが 7 日以内に満杯の見込み | 手順書の対策を PR にする | P1 |
   | 危険 `critical` | 95% 以上 | 今日中に対策を入れるか、課金を決める | P0 |

   ストレージ（D1 / R2）は過去 7 日の増え方から、満杯になる日を見積もる（30 日以内で注意、7 日以内で対策）。
   1 日の枠は UTC 0 時（日本時間 9 時）から 3 時間たつまで見積もらない（数字が荒れるため）。
3. **知らせる**: usage-meter が管理者にメールとアプリ内通知を送る（同じ項目・同じ段階は 1 日 1 回）。
4. **Issue にする**: GitHub Actions の `usage-escalation`（6 時間ごと）が、注意以上の項目ごとに Issue を作る。
   - タイトルは `[usage:<metricKey>] …`。**項目ごとに開いている Issue は 1 つ**で、2 回目以降はコメントで追記する。
   - 同じ日に同じ段階なら何もしない。段階が上がった時だけ追記し、危険になったら P1 を外して P0 を付ける。
   - 本文: 状況（使用量・見込み・リセット）／何が使っているか（GraphQL の上位 5 件）／対策（手順書から）／課金するか（値段と選択肢）。
5. **決める**: Issue の「課金するか」で 1 つ選び、理由をコメントに残す。
   - 対策 → 手順書の対策を PR にする。落ち着いたら Issue を閉じる。
   - 課金 → 契約は人が行う。契約したら Issue に日付と金額を書き、`services/usage-meter/src/limits.ts` の該当項目の
     `overflowBehavior` を `"bill"` にする（止まらなくなった代わりに請求が出ることを画面に出すため）。
6. **画面**: fe2 の `/usage`（使用量）で、項目ごとに段階・見込み・Issue・手順書・課金した場合の値段を見られる。

## 項目別の手順書

| 項目（metricKey） | 手順書 | 課金する場合 |
|---|---|---|
| D1 行読み取り `d1_rows_read_day` | [d1-rows-read.md](./d1-rows-read.md) | Workers Paid $5/月 |
| D1 行書き込み `d1_rows_written_day` | [d1-rows-written.md](./d1-rows-written.md) | Workers Paid $5/月 |
| D1 ストレージ `d1_storage` | [d1-storage.md](./d1-storage.md) | Workers Paid $5/月 |
| Workers リクエスト `workers_requests_day` | [workers-requests.md](./workers-requests.md) | Workers Paid $5/月 |
| KV 読み取り / 書き込み `kv_reads_day` `kv_writes_day` | [kv.md](./kv.md) | Workers Paid $5/月 |
| R2 ストレージ / Class A / Class B | [r2.md](./r2.md) | R2 従量課金（月額なし） |
| メール送信（日 / 月）`resend_emails_*` | [email-sending.md](./email-sending.md) | Resend Pro $20/月 |
| Durable Objects / Queues `do_requests_day` | [queues-do.md](./queues-do.md) | Workers Paid $5/月 |
| Google Calendar / Meet API | [google-apis.md](./google-apis.md) | 課金なし（クォータ申請） |

値段は 2026 年の公開価格（USD）。変わることがあるので、課金を決める前に各社の料金ページで確かめる。
**Workers Paid は 1 アカウント 1 契約で Workers / D1 / KV / Durable Objects / Queues をまとめて従量課金にする**ので、
D1 のために入れると他も止まらなくなる（=使った分だけ請求）。

## 課金が正しい時（共通の目安）

- 対策をしても、**利用者が増えたこと自体**で毎日のように注意以上になる（一時的な増加ではない）
- 対策が機能を削る（ポーリングを止める・保存期間を極端に短くする）ことになり、使い勝手を落とす
- 止まった時の影響が大きい（イベント当日・チケット販売中）のに、対策が間に合わない
- 対策にかかる手間が、月 $5〜$20 より明らかに高い

逆に、**1 つのクエリ・1 つのループが原因**なら、まず直す（#911 は rows read を 30〜40% 減らした）。

## 使っている所の調べ方（共通）

Cloudflare GraphQL Analytics を使う。トークンは Analytics の読み取り権限があるもの（usage-meter の
`USAGE_CF_ANALYTICS_TOKEN`、または deploy 用の `CLOUDFLARE_API_TOKEN`）。各手順書のクエリをこの形で投げる。

```sh
curl -s https://api.cloudflare.com/client/v4/graphql \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'content-type: application/json' \
  --data "$(jq -n --arg q "$QUERY" --arg a "$CLOUDFLARE_ACCOUNT_ID" \
    '{query:$q, variables:{a:$a, s:"2026-11-26T00:00:00Z", e:"2026-11-27T00:00:00Z"}}')" | jq .
```

日付で絞るデータセット（`date_geq`）は `s` / `e` を `2026-11-26` の形にする。
`orderBy` を受け付けないデータセットがあり、その時は応答全体が null になる。手順書に書いたクエリはそのまま使える。

## Issue の手動実行

- GitHub → Actions → `usage escalation` → Run workflow（`dry_run` にすると投稿せずログに本文を出す）
- 手元で本文だけ見る: `pnpm --filter @dub/usage-meter exec tsx scripts/usage-escalation.ts --rows rows.json --dry-run`
  （`rows.json` は `--print-sql` の SELECT の結果。本番 D1 を読むので、手元では staging の D1 か作った例で試す）

## 関連

- 計測と通知: `services/usage-meter/`（`limits.ts` = 上限、`escalation.ts` = 段階と見込み、`playbook.ts` = 対策と値段）
- Issue 作成: `.github/workflows/usage-escalation.yml`、`services/usage-meter/src/escalate.ts`
- 画面: `apps/fe2-app-shell/src/features/usage/`
