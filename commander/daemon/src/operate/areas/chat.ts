// チャット (chat-service). Writes run as the bot's session, so the bot is the sender.
import type { AreaSpec } from "../catalog-types.ts";
import { read } from "./helpers.ts";

const S = "chat-service";
const VIEW = { keys: [], appLevel: { app: "chat", level: "view" } } as const;
const EDIT = { keys: [], appLevel: { app: "chat", level: "edit" } } as const;
const CREATE = { keys: ["chat:create"], appLevel: { app: "chat", level: "edit" } } as const;
const SLACK = { keys: ["chat:slack_import"], appLevel: { app: "chat", level: "edit" } } as const;
const EMOJI_IMPORT = { keys: ["chat:emoji_import"], appLevel: { app: "chat", level: "edit" } } as const;
const SIDEBAR = "ボット自身のサイドバーのセクション分けで、Dub のデータではない";
const SLACK_NOT_CONFIGURED = "chat-service に SLACK_BOT_TOKEN が無いと 412";
const JOB_FIELDS =
  "id・slackChannelId・slackChannelName・isPrivate・dubChannelId（取り込み先の Dub チャンネル）・status（queued|running|done|failed）・phase・" +
  "counters（messages・threadReplies・reactions・pins・files 等）・pending・error（{ code, message } | null）";
const CHANNEL_ADMIN = "ボットがそのチャンネルの管理者（自分で作ったチャンネル等）でないと拒否される";

export const CHAT: AreaSpec = {
  area: "chat",
  entries: [
    read({
      id: "chat.channels.list",
      area: "chat",
      path: "/chat/channels",
      service: S,
      requires: VIEW,
      description: "チャットのチャンネル一覧を取得する",
      hint: "公開チャンネル＋ボットが参加中の非公開。アーカイブ済みは出ない。items[].id・type・visibility・name・topic・eventId・version",
      query: ["eventId", "limit", "cursor"],
    }),
    read({
      id: "chat.channels.get",
      area: "chat",
      path: "/chat/channels/:id",
      service: S,
      requires: VIEW,
      description: "チャンネル1件を取得する",
      hint: "{ channel: { id, name, topic, archivedAt, version }, membership }。アーカイブ済みもこれなら読める",
    }),
    read({
      id: "chat.members.list",
      area: "chat",
      path: "/chat/channels/:id/members",
      service: S,
      requires: VIEW,
      description: "チャンネルの参加メンバーを取得する",
      hint: "配列 [{ userId, role }]",
    }),
    read({
      id: "chat.pins.list",
      area: "chat",
      path: "/chat/channels/:id/pins",
      service: S,
      requires: VIEW,
      description: "チャンネルのピン留めメッセージを取得する",
      hint: "配列 [{ id, body, authorId }]（新しいメッセージ順・全件）",
    }),
    read({
      id: "chat.search",
      area: "chat",
      path: "/chat/search",
      service: S,
      requires: VIEW,
      description: "チャットのメッセージを検索する",
      hint: "query.q 必須。配列 [{ message: { id, body, authorId }, channelId, channelName }]",
      query: ["q", "channelId", "limit"],
    }),
    read({
      id: "chat.messages.list",
      area: "chat",
      path: "/chat/messages",
      service: S,
      requires: VIEW,
      description: "チャンネルのメッセージを取得する",
      hint: "query.channelId 必須。items[].id・authorId・body・version・deletedAt・reactions（{ 絵文字: [付けた人の userId] }）。threadRootId でスレッド内",
      query: ["channelId", "threadRootId", "afterMessageId", "limit", "cursor"],
    }),
    read({
      id: "chat.slackImport.channels",
      area: "chat",
      path: "/chat/slack-import/channels",
      service: S,
      requires: SLACK,
      description: "取り込める Slack のチャンネル一覧を取得する",
      hint:
        "{ items: [{ id, name, isPrivate, isArchived, memberCount, job（前に取り込んだジョブ { id, status } | null） }] }。" +
        `非公開チャンネルは Slack で LMB を招待したものだけ出る。${SLACK_NOT_CONFIGURED}`,
    }),
    read({
      id: "chat.slackImport.jobs.list",
      area: "chat",
      path: "/chat/slack-import/jobs",
      service: S,
      requires: SLACK,
      description: "Slack 取り込みの状況一覧を取得する",
      hint: `{ items: [ジョブ] }（更新の新しい順・limit 既定 20 / 最大 50）。ジョブ = ${JOB_FIELDS}`,
      query: ["limit"],
    }),
    read({
      id: "chat.slackImport.jobs.get",
      area: "chat",
      path: "/chat/slack-import/jobs/:id",
      service: S,
      requires: SLACK,
      description: "Slack 取り込みの状況を1件取得する",
      hint: `ジョブ = ${JOB_FIELDS}`,
    }),
    read({
      id: "chat.customEmojis.list",
      area: "chat",
      path: "/chat/custom-emojis",
      service: S,
      requires: VIEW,
      description: "登録済みのカスタム絵文字の一覧を取得する",
      hint: "{ items: [{ name, aliasOf, contentType, source（slack|upload）, createdAt }] }（名前順・全件）。リアクションでは :name: で使う",
    }),
    read({
      id: "chat.settings.deletionPolicy",
      area: "chat",
      path: "/chat/settings/deletion-policy",
      service: S,
      requires: VIEW,
      description: "メッセージ削除の方式（完全削除か痕跡を残すか）の設定を取得する",
      hint: "{ policy: { member, moderator }, version }。hard=完全削除",
    }),
    {
      id: "chat.channels.create",
      area: "chat",
      method: "POST",
      path: "/chat/channels",
      service: S,
      requires: CREATE,
      kind: "write",
      reversible: true,
      risk: "mid",
      description: "チャンネルを新しく作る",
      hint:
        "type は event|topic|dm、visibility は public|private、name 必須。type=event は eventId 必須（events.list で探す）。" +
        "memberIds で最初の参加者を指定（ボットは自動で管理者として入る）。dm は同じ顔ぶれの既存 DM が返る。応答は作成した channel（id・version）",
      impact: "{count}件のチャンネルができます。公開なら全員の一覧に出ます。不要ならアーカイブで一覧から消せます。",
      body: { allowed: ["type", "visibility", "name", "topic", "eventId", "memberIds"], required: ["type", "visibility", "name"] },
      fieldLabels: { type: "種類", visibility: "公開範囲", name: "チャンネル名", topic: "トピック", eventId: "イベント", memberIds: "最初の参加者" },
      verify: {
        read: "chat.channels.get",
        params: { id: "$result.id" },
        expect: {
          "channel.name": "$body.name",
          "channel.type": "$body.type",
          "channel.visibility": "$body.visibility",
          "channel.topic": "$body.topic",
          "channel.eventId": "$body.eventId",
        },
      },
    },
    {
      id: "chat.channels.update",
      area: "chat",
      method: "PATCH",
      path: "/chat/channels/:id",
      service: S,
      requires: EDIT,
      kind: "write",
      reversible: true,
      risk: "mid",
      description: "チャンネルの名前・トピックを変える、またはアーカイブする／戻す",
      hint: `version 必須（直前に chat.channels.get で channel.version を読む）。name・topic・archived（true=アーカイブ / false=戻す）は変えるものだけ送る。${CHANNEL_ADMIN}`,
      impact: "{count}件のチャンネルの表示が全参加者の画面で変わります。アーカイブは一覧から消えますが、戻せば元どおりです。",
      body: { allowed: ["version", "name", "topic", "archived"], required: ["version"] },
      fieldLabels: { name: "チャンネル名", topic: "トピック", archived: "アーカイブ" },
      verify: {
        read: "chat.channels.get",
        params: { id: "$params.id" },
        expect: {
          "channel.name": "$body.name",
          "channel.topic": "$body.topic",
          "channel.archivedAt": "$result.archivedAt",
          "channel.version": "$result.version",
        },
      },
    },
    {
      id: "chat.members.add",
      area: "chat",
      method: "POST",
      path: "/chat/channels/:id/members",
      service: S,
      requires: EDIT,
      kind: "write",
      reversible: true,
      risk: "mid",
      description: "チャンネルにメンバーを追加する",
      hint: `userId 必須（users.list で探す）、role は admin|member（既定 member）。既に参加中なら何もしない（役割も変わらない）。アーカイブ済みには追加できない。${CHANNEL_ADMIN}`,
      impact: "{count}人がチャンネルに追加され、そのチャンネルが本人の一覧に出ます。外せば元に戻ります。",
      body: { allowed: ["userId", "role"], required: ["userId"] },
      fieldLabels: { userId: "メンバー", role: "役割" },
      verify: {
        read: "chat.members.list",
        params: { id: "$params.id" },
        findIn: "[*]",
        findBy: ["userId", "$body.userId"],
        expect: { role: "$body.role" },
      },
    },
    {
      id: "chat.members.remove",
      area: "chat",
      method: "DELETE",
      path: "/chat/channels/:id/members/:userId",
      service: S,
      requires: EDIT,
      kind: "delete",
      reversible: true,
      risk: "high",
      description: "チャンネルからメンバーを外す",
      hint:
        `${CHANNEL_ADMIN}（ボット自身を外す場合を除く）。ボット自身を非公開チャンネルから外すと以後そのチャンネルを読めず、追加し直せない。` +
        "参加していない人を指定しても何もしない",
      impact: "{count}人がチャンネルから外れます。非公開チャンネルは本人から見えなくなります。追加し直せば戻せます（過去のメッセージは残ります）。",
      verify: {
        read: "chat.members.list",
        params: { id: "$params.id" },
        findIn: "[*]",
        findBy: ["userId", "$params.userId"],
        present: false,
      },
    },
    {
      id: "chat.messages.post",
      area: "chat",
      method: "POST",
      path: "/chat/messages",
      service: S,
      requires: EDIT,
      kind: "write",
      reversible: true,
      risk: "mid",
      description: "チャンネルにメッセージを送る（送信者はボット）",
      hint:
        "channelId・body 必須。threadRootId でスレッドに返信。attachmentFileIds は登録済みファイルの id。" +
        "本文の <@ユーザーid> / <!team:チームid> はメンションで相手に通知が飛ぶ。公開チャンネルはボットが未参加でも送ると自動参加する。アーカイブ済みには送れない。応答は送ったメッセージ（id・version）",
      impact: "{count}件のメッセージがボットの名前でチャンネル参加者全員に表示されます。削除はできますが、メンションで飛んだ通知は消えません。",
      body: { allowed: ["channelId", "body", "threadRootId", "attachmentFileIds"], required: ["channelId", "body"] },
      fieldLabels: { channelId: "チャンネル", body: "本文", threadRootId: "返信先", attachmentFileIds: "添付ファイル" },
      verify: {
        read: "chat.messages.list",
        query: { channelId: "$body.channelId", threadRootId: "$body.threadRootId", limit: "200" },
        findIn: "items",
        findBy: ["id", "$result.id"],
        expect: { body: "$body.body", authorId: "$notNull" },
      },
    },
    {
      id: "chat.messages.edit",
      area: "chat",
      method: "PATCH",
      path: "/chat/messages/:id",
      service: S,
      requires: EDIT,
      kind: "write",
      reversible: true,
      risk: "mid",
      description: "ボットが送ったメッセージの本文を書き換える",
      hint:
        "version・body 必須（直前に chat.messages.list で対象の version を読む）。作者本人しか編集できないので、ボット自身が送ったメッセージ（authorId=ボット）だけが対象。削除済み・アーカイブ済みチャンネルは不可",
      impact: "{count}件のメッセージの本文が全参加者の画面で書き換わり「編集済み」と出ます。もう一度編集すれば戻せます。",
      body: { allowed: ["version", "body"], required: ["version", "body"] },
      fieldLabels: { body: "本文" },
      verify: {
        read: "chat.messages.list",
        query: { channelId: "$result.channelId", threadRootId: "$result.threadRootId", limit: "200" },
        findIn: "items",
        findBy: ["id", "$params.id"],
        expect: { body: "$body.body", version: "$result.version" },
      },
    },
    {
      id: "chat.messages.delete",
      area: "chat",
      method: "DELETE",
      path: "/chat/messages/:id",
      service: S,
      requires: EDIT,
      kind: "delete",
      reversible: false,
      risk: "high",
      description: "メッセージを削除する",
      hint:
        "作者本人かチャンネル管理者だけが削除できる＝ボット自身の投稿か、ボットが管理者のチャンネル（自分で作った等）の投稿だけ。" +
        "削除方式は chat.settings.deletionPolicy に従う（既定 hard=完全に消え、スレッドの返信・リアクション・ピンも一緒に消える / tombstone=「削除されました」の痕跡が残る）。応答 { mode, message }",
      impact: "{count}件のメッセージが全参加者の画面から消えます。完全削除の設定（既定）では返信ごと消え、元に戻せません。",
      unverifiable:
        "メッセージを1件だけ読む手段が無く、一覧は新しい順の一部しか返さない（スレッドの返信は別の一覧）ため、一覧に無いことでは「消えた」と確かめられない",
    },
    {
      id: "chat.reactions.toggle",
      area: "chat",
      method: "POST",
      path: "/chat/messages/:id/reactions",
      service: S,
      requires: EDIT,
      kind: "write",
      reversible: true,
      risk: "mid",
      description: "メッセージにリアクションを付ける／外す（付けた人はボット）",
      hint:
        "emoji 必須（標準の絵文字は文字そのもの例 👍、カスタム絵文字は :name: 形式）。付け外しの切り替えなので、既にボットが同じ絵文字を付けていれば外れる。" +
        "付ける（外す）前に必ず chat.messages.list で対象の reactions を読み、ボットの userId が入っていない（入っている）ことを確かめてから呼ぶ（ボットの userId はボットが送ったメッセージの authorId で分かる。分からないままその絵文字が既に付いていれば、付くか外れるか分からないと要約に書く）。" +
        "削除済みメッセージ・ボットが書き込めないチャンネルには不可。応答 { messageId, reactions }（切り替え後の全リアクション）",
      impact: "{count}件のメッセージのリアクションがボットの名前で全参加者の画面で切り替わります。もう一度同じ絵文字で切り替えれば元に戻ります。",
      body: { allowed: ["emoji"], required: ["emoji"] },
      fieldLabels: { emoji: "絵文字" },
      unverifiable:
        "応答にチャンネルが含まれず、メッセージを1件だけ読む手段も無いため、付け外し後の状態を読み直して確かめられない",
    },
    {
      id: "chat.pins.toggle",
      area: "chat",
      method: "POST",
      path: "/chat/channels/:id/pins",
      service: S,
      requires: EDIT,
      kind: "write",
      reversible: true,
      risk: "mid",
      description: "チャンネルのメッセージをピン留めする／外す",
      hint:
        "messageId 必須（そのチャンネルのメッセージ。chat.messages.list で探す）。付け外しの切り替えなので、既にピン留めされていれば外れる（誰がピンしたかは問わない）。" +
        "ピン留めする（外す）前に必ず chat.pins.list で対象が無い（有る）ことを確かめてから呼ぶ。アーカイブ済み・削除済みメッセージは不可。応答は切り替え後のピン留め一覧（配列）",
      impact: "{count}件のメッセージのピン留めが全参加者の画面で切り替わります。もう一度切り替えれば元に戻ります。",
      body: { allowed: ["messageId"], required: ["messageId"] },
      fieldLabels: { messageId: "メッセージ", "[*].id": "ピン留めの一覧" },
      // Toggle: the direction is unknown up front, so compare the re-read list with the
      // post-toggle list the write returned (complete, unpaginated).
      verify: {
        read: "chat.pins.list",
        params: { id: "$params.id" },
        expect: { "[*].id": "$result.[*].id" },
      },
    },
    {
      id: "chat.slackImport.jobs.start",
      area: "chat",
      method: "POST",
      path: "/chat/slack-import/jobs",
      service: S,
      requires: SLACK,
      kind: "write",
      reversible: false,
      risk: "high",
      description: "Slack のチャンネルを Dub のチャットに取り込み始める",
      hint:
        "channel 必須（Slack のチャンネル名 #general / general か id。chat.slackImport.channels で探す）。ジョブは Slack チャンネルごとに1つ：" +
        "既存が queued|running ならそのまま返す、failed なら止まった所から再開、done なら最初からやり直す（同じメッセージは重複しない・その後の投稿も入る）。新規は 201、既存は 200。" +
        "応答はジョブ（id・status・dubChannelId）。この操作だけでは取り込みは進まない：チャットの取り込み画面を開いている間だけ進み、開くと queued|running のジョブを自動で再開する。" +
        `進み具合は chat.slackImport.jobs.get で見る。見つからない Slack チャンネルは 404（非公開は LMB の招待が必要）。${SLACK_NOT_CONFIGURED}`,
      impact:
        "{count}件の Slack チャンネルの取り込みが始まり、チャットの取り込み画面の状況一覧に出ます。取り込みはその画面を開いている間に進み、Slack の公開チャンネルには LMB が参加します。" +
        "終わると Dub にチャンネルと過去のメッセージ・リアクション・ピン・添付ができ（ボットも参加者になります）、取り込んだ内容は取り消せません。",
      body: { allowed: ["channel"], required: ["channel"] },
      fieldLabels: { channel: "Slack チャンネル", slackChannelId: "Slack チャンネル", dubChannelId: "取り込み先" },
      // Progress moves on its own once the screen drives the job, so only its identity is compared.
      verify: {
        read: "chat.slackImport.jobs.get",
        params: { id: "$result.id" },
        expect: { slackChannelId: "$result.slackChannelId", dubChannelId: "$result.dubChannelId" },
      },
    },
    {
      id: "chat.customEmojis.importFromSlack",
      area: "chat",
      method: "POST",
      path: "/chat/custom-emojis/slack-import",
      service: S,
      requires: EMOJI_IMPORT,
      kind: "write",
      reversible: false,
      risk: "mid",
      description: "Slack のカスタム絵文字を取り込む（1回で最大20件）",
      hint:
        "after は前回の応答の nextAfter（最初は送らない）。1回で名前順に未登録の画像を最大 20 件登録し、対象画像が登録済みの別名も一緒に入る。登録済みの名前はスキップする（上書きしない）ので再実行は安全。" +
        "応答 { total, imported（登録済み数）, added（今回登録した数）, skipped, failed[]（取れなかった画像名）, nextAfter, retryAfterMs }。" +
        "nextAfter が null でなければ続きがあるので after=nextAfter で次の操作として呼ぶ。retryAfterMs>0 は Slack の回数制限で、その時間待って同じ after で呼び直す。" +
        `結果は chat.customEmojis.list で確かめる。${SLACK_NOT_CONFIGURED}`,
      impact: "Slack のカスタム絵文字が{count}回分（1回で最大20件）組織全体に登録され、リアクションで使えるようになります。登録済みの絵文字は変わりません。登録した絵文字を消す手段はありません。",
      body: { allowed: ["after"], required: [] },
      fieldLabels: { after: "続きの位置" },
      unverifiable: "応答は件数だけで登録した絵文字の名前を返さないため、一覧を読み直して今回の分を照合できない",
    },
  ],
  excluded: [
    { service: S, route: "GET /chat/channels/:id/ws-ticket", reason: "リアルタイム接続用の券でデータではない" },
    { service: S, route: "GET /chat/unfurl", reason: "外部 URL を取りに行くリンク展開で、Dub のデータではない" },
    { service: S, route: "GET /chat/unread", reason: "ボット自身の未読数で、Dub のデータではない" },
    { service: S, route: "POST /chat/channels/:id/read", reason: "ボット自身の既読位置の更新で、Dub のデータではない" },
    {
      service: S,
      route: "PATCH /chat/settings/deletion-policy",
      reason: "組織全体の削除方式を変える設定。完全削除に切り替えると以後の削除が復元不能になる",
    },
    {
      service: S,
      route: "DELETE /chat/channels/:id",
      reason: "チャンネルと全メッセージを物理削除する操作で復元不能。アーカイブ（chat.channels.update）で一覧から消せる",
    },
    { service: S, route: "GET /chat/sections", reason: SIDEBAR },
    { service: S, route: "POST /chat/sections", reason: SIDEBAR },
    { service: S, route: "PATCH /chat/sections/:id", reason: SIDEBAR },
    { service: S, route: "DELETE /chat/sections/:id", reason: SIDEBAR },
    { service: S, route: "PUT /chat/channels/:id/section", reason: SIDEBAR },
    {
      service: S,
      route: "POST /chat/slack-import/jobs/:id/step",
      reason: "取り込みの進行はチャットの取り込み画面が担う。開くと自動で再開する",
    },
    { service: S, route: "GET /chat/custom-emojis/:name/image", reason: "絵文字の画像そのもの（バイナリ）の配信で、データとして読むものではない" },
  ],
  pending: [],
  ownerOpenedIrreversible: {
    "chat.slackImport.jobs.start":
      "取り込みを止める・取り込んだチャンネルを消す API が無い。オーナーが「チャットの Slack 取り込みを操作する」を名指しで開放。確認フレーズ必須の高リスクで承認画面に出す",
    "chat.customEmojis.importFromSlack":
      "登録した絵文字を消す API は無いが、追加だけで既存の絵文字は変えない。オーナーが Slack 取り込みと合わせて名指しで開放",
    "chat.messages.delete":
      "オーナーが依頼表で「メッセージの削除」を名指しした。既定の完全削除は復元できないため、確認フレーズ必須の高リスクで承認画面に対象を出す",
  },
};
