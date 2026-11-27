# event-digest-agent（Mac mini 側・準備中）

イベントアプリの「AI のまとめ」と質問欄（#879）を、Mac mini のローカル LLM で動かすための接続役。
**Mac mini が届くまで機能は OFF。** 本番では要約も質問も「停止中」と表示され、外部の LLM には何も送らない。

## しくみ

- Mac mini から Cloudflare へ **外向き** に WebSocket でつなぐ（家のポートは開けない）。形は `services/commander-relay` と同じ。
- つなぐ先は event-service の Durable Object `EventDigestHub`（`services/event-service/src/digest-hub.ts`）。
  - `/agent/event-digest/ws` に `Authorization: Bearer <DIGEST_AGENT_SECRET>` で接続。フラグ OFF の間は 401。
  - DO から `{t:"req", id, op:"summarize"|"ask", payload}` が来るので `{t:"res", id, ok, body}` で返す。
  - つながっていない・60 秒で返事が無い → 画面は「停止中」。外部 LLM への切り替えはしない（オーナー決定）。
- 定期の要約は DO のアラーム（毎日 7:00 JST・本番前の 1 週間は 3 時間ごと）。Cron は足していない（アカウントの上限 5 本が埋まっているため）。

## Mac mini が届いたら（有効化の手順）

1. Mac mini にローカル LLM（Inkling 2 Mini）を入れ、OpenAI 互換の API を `127.0.0.1` で立てる。
2. シークレットを入れる: `wrangler secret put DIGEST_AGENT_SECRET --config services/event-service/wrangler.free.toml`
3. Mac mini が届く公開の入口を 1 本だけ作る（event-service は `workers_dev = false` なので、`/agent/event-digest/ws` だけを通す route を足す）。
4. 読み取り元の Service Binding を `wrangler.free.toml` に足す（足さなかった元は飛ばされるだけ）:
   `SVC_LP_TICKETS` / `SVC_LP_ANALYTICS` / `SVC_DRIVE_SHARE` / `SVC_CHAT` / `SVC_MAIL` / `SVC_DRIVE`。
   ドライブは `EVENT_AI_DIGEST_DRIVE_FOLDER_ID`（オーナーが決めた 1 フォルダ）を入れた時だけ読む。
5. 定期実行で使う読み取りユーザーを `EVENT_AI_DIGEST_SYSTEM_USER_ID` に入れる（無ければ定期実行は飛ばす）。
6. `EVENT_AI_DIGEST_ENABLED = "1"` にしてデプロイし、DO の `/ensure-alarm` を 1 回叩いてアラームを始める。
7. Mac mini で起動:

```sh
DIGEST_HUB_URL=wss://<入口のホスト>/agent/event-digest/ws \
DIGEST_AGENT_SECRET=<2 と同じ値> \
LOCAL_LLM_URL=http://127.0.0.1:8080/v1/chat/completions \
node tools/event-digest-agent/agent.mjs
```

8. イベントアプリは、管理者だけに表示されている「AI のまとめ」を、一般メンバーにも公開する時に `apps/fe3-event-action/src/lib/aiDigestRelease.ts` の `AI_DIGEST_RELEASED` を `true` にする。

## 送らないもの

メール本文・チャットの雑談・名簿・チケット購入者は、どの LLM にも送らない。集める側（`services/event-service/src/digest/collectors.ts`）が欄を名前で選んで取り出し、メールアドレス・電話番号・長い数字の並びは伏せ字にしてから渡す。
