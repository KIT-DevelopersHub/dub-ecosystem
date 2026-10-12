// チャット (chat-service). Writes run as the bot's session, so the bot is the sender.
import type { AreaSpec } from "../catalog-types.ts";
import { read } from "./helpers.ts";

const S = "chat-service";
const VIEW = { keys: [], appLevel: { app: "chat", level: "view" } } as const;

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
      hint: "配列 [{ id, body, authorId }]",
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
      hint: "query.channelId 必須。items[].id・authorId・body・version・deletedAt。threadRootId でスレッド内",
      query: ["channelId", "threadRootId", "afterMessageId", "limit", "cursor"],
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
  ],
  pending: [
    { service: S, route: "POST /chat/channels" },
    { service: S, route: "PATCH /chat/channels/:id" },
    { service: S, route: "POST /chat/channels/:id/members" },
    { service: S, route: "DELETE /chat/channels/:id/members/:userId" },
    { service: S, route: "POST /chat/messages" },
    { service: S, route: "PATCH /chat/messages/:id" },
    { service: S, route: "DELETE /chat/messages/:id" },
    { service: S, route: "POST /chat/channels/:id/pins" },
    { service: S, route: "POST /chat/messages/:id/reactions" },
  ],
};
