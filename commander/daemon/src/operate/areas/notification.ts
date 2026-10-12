// 通知 (notification). The service also serves every route at the bare root; the gateway
// only reaches the `/notifications/*` and `/feedback` forms, so only those are in scope.
import type { AreaSpec } from "../catalog-types.ts";
import { read } from "./helpers.ts";

const S = "notification";
const MANAGE_VIEW = { keys: ["notif:broadcast_publish"], appLevel: { app: "notifications", level: "view" } } as const;
const MANAGE_EDIT = { keys: ["notif:broadcast_publish"], appLevel: { app: "notifications", level: "edit" } } as const;
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
  ],
  pending: [
    { service: S, route: "POST /notifications/release" },
    { service: S, route: "PATCH /feedback/:id/read" },
  ],
};
