// 通知 (notification). The service also serves every route at the bare root; the gateway
// only reaches the `/notifications/*` and `/feedback` forms, so only those are in scope.
import type { AreaSpec } from "../catalog-types.ts";
import { read } from "./helpers.ts";

const S = "notification";
const MANAGE_VIEW = { keys: ["notif:broadcast_publish"], appLevel: { app: "notifications", level: "view" } } as const;
const MANAGE_EDIT = { keys: ["notif:broadcast_publish"], appLevel: { app: "notifications", level: "edit" } } as const;
const ADMIN_EDIT = { keys: ["notif:admin"], appLevel: { app: "notifications", level: "edit" } } as const;
const ADMIN_VIEW = { keys: ["notif:admin"], appLevel: { app: "notifications", level: "view" } } as const;
const INBOX = { keys: ["notif:inbox:self"], appLevel: { app: "notifications", level: "view" } } as const;
const BULK = "一括エンドポイントは使わない（1件ずつ呼んで全件を読み直す）";
const SELF = "ボット自身の受信箱・設定の操作で、Dub のデータではない";

export const NOTIFICATION: AreaSpec = {
  area: "notification",
  entries: [
    read({
      id: "notifications.manage.list",
      area: "notification",
      path: "/notifications/manage",
      service: S,
      requires: MANAGE_VIEW,
      description: "管理者通知の一覧を取得する",
      hint: "items[].id・title・body・publishedBroadcastId（非nullならメンバーに公開中）",
      query: ["limit", "cursor"],
    }),
    read({
      id: "notifications.inbox.list",
      area: "notification",
      path: "/notifications/inbox",
      service: S,
      requires: INBOX,
      description: "メンバー向けに届いている通知（ボットの受信箱）を取得する",
      hint: "全員宛ての通知はボットにも届く。items[].id（受信箱の行id）・type・title・body・createdAt",
      query: ["unreadOnly", "limit", "cursor"],
    }),
    read({
      id: "feedback.list",
      area: "notification",
      path: "/feedback",
      service: S,
      requires: ADMIN_VIEW,
      description: "メンバーから届いたフィードバックの一覧を取得する",
      hint: "items[].id・category・message・pageName・readAt",
      query: ["unreadOnly", "limit", "cursor"],
    }),
    {
      id: "notifications.unpublish",
      area: "notification",
      method: "POST",
      path: "/notifications/manage/:id/unpublish",
      service: S,
      requires: MANAGE_EDIT,
      kind: "delete",
      reversible: true,
      risk: "high",
      description: "通知を削除する（メンバー全員の受信箱から取り下げる）",
      hint: "管理者側の元の通知は残る。公開中のもの（publishedBroadcastId 非null）が対象",
      impact: "{count}件の通知がメンバー全員の受信箱から消えます。再公開で戻せますが、各メンバーの既読状態は失われます。",
      verify: {
        read: "notifications.manage.list",
        query: { limit: "200" },
        findIn: "items",
        findBy: ["id", "$params.id"],
        expect: { publishedBroadcastId: null },
      },
    },
    {
      id: "notifications.publish",
      area: "notification",
      method: "POST",
      path: "/notifications/manage/:id/publish",
      service: S,
      requires: MANAGE_EDIT,
      kind: "write",
      reversible: true,
      risk: "mid",
      description: "管理者通知をメンバー全員に公開する",
      impact: "{count}件の通知がメンバー全員の受信箱に届きます。取り下げれば消せます。",
      verify: {
        read: "notifications.manage.list",
        query: { limit: "200" },
        findIn: "items",
        findBy: ["id", "$params.id"],
        expect: { publishedBroadcastId: "$notNull" },
      },
    },
    {
      id: "notifications.release",
      area: "notification",
      method: "POST",
      path: "/notifications/release",
      service: S,
      requires: ADMIN_EDIT,
      kind: "write",
      reversible: false,
      risk: "high",
      description: "お知らせを新規に作り、メンバー全員の受信箱に送る",
      hint:
        "title(1..200)・body(1..2000) 必須、app（対象アプリ名）・publishedAt（ISO8601）任意。前後の空白は削られる。" +
        "同じ title(+app) は二重送信防止で既存の通知が返り本文は更新されない（文言を変えて送り直すなら title も変える）。" +
        "送った通知を編集・取り下げる API は無い。応答 { notificationId, deduplicated }",
      impact: "{count}件のお知らせがメンバー全員の受信箱に届きます。送った後は編集も取り下げもできません。",
      body: { allowed: ["title", "body", "app", "publishedAt"], required: ["title", "body"] },
      fieldLabels: { title: "件名", body: "本文", app: "対象アプリ", publishedAt: "公開日時" },
      // Delivered to every active member, the bot included: its own inbox is the read-back.
      verify: {
        read: "notifications.inbox.list",
        query: { limit: "200" },
        findIn: "items",
        findBy: ["title", "$body.title"],
        expect: { body: "$body.body", type: "release" },
      },
    },
  ],
  excluded: [
    { service: S, route: "POST /notifications/manage/publish-batch", reason: BULK },
    { service: S, route: "POST /notifications/manage/unpublish-batch", reason: BULK },
    { service: S, route: "GET /notifications/inbox/ws-ticket", reason: "リアルタイム接続用の券でデータではない" },
    { service: S, route: "GET /notifications/inbox/unread-count", reason: SELF },
    { service: S, route: "PATCH /notifications/inbox/:id/read", reason: SELF },
    { service: S, route: "PATCH /notifications/inbox/:id/unread", reason: SELF },
    { service: S, route: "POST /notifications/inbox/read-all", reason: SELF },
    { service: S, route: "GET /notifications/preferences", reason: SELF },
    { service: S, route: "PATCH /notifications/preferences", reason: SELF },
    { service: S, route: "POST /feedback", reason: "フィードバックを送る側の操作で、ボットが送る用途が無い" },
    {
      service: S,
      route: "PATCH /feedback/:id/read",
      reason: "依頼範囲外。フィードバックを既読にする操作で、未読に戻す手段が無く取り消せない",
    },
  ],
  pending: [],
  ownerOpenedIrreversible: {
    "notifications.release":
      "オーナーが依頼表で「通知の新規送信」を名指しした。送った通知を取り下げる API は無いため、全員に届く前に承認画面で件名と本文を確かめる（確認フレーズ必須）",
  },
};
