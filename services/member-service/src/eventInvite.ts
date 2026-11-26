// 「〇〇の運営に招待されました」— アカウントのある人をイベントの運営メンバーに招待した時の
// in-app 通知。今は承諾の手順が無く、招待した時点でそのイベントの運営メンバーに入る。
// 通知は best-effort: 送れなくても招待 (追加) は成功させ、`notified: false` で画面に伝える。
import type { Fetcher } from "@cloudflare/workers-types";
import { createServiceClient } from "@dub/http";
import type { notification } from "@dub/types";

export const EVENT_INVITED_TYPE = "member.event_invited";

export interface EventInviteTarget {
  eventId: string;
  eventTitle: string;
  personId: string;
  identityUserId: string;
}

export function buildEventInvite(t: EventInviteTarget): notification.NotifyRequest {
  return {
    type: EVENT_INVITED_TYPE,
    recipientIds: [t.identityUserId],
    title: `「${t.eventTitle}」の運営に招待されました`,
    body: `「${t.eventTitle}」の運営メンバーに追加されました。開いてイベントを確認してください。`,
    channels: ["in_app"],
    dedupKey: `${EVENT_INVITED_TYPE}:${t.eventId}:${t.personId}`,
    // NotificationCard.itemLinkUrl: resourceType "event" -> /events/:id
    resourceType: "event",
    resourceId: t.eventId,
  };
}

export type EventInviteNotifier = (ctx: { requestId: string; userId: string }, target: EventInviteTarget) => Promise<void>;

export function eventInviteNotifierVia(svcNotification: Fetcher): EventInviteNotifier {
  const client = createServiceClient(svcNotification, { service: "notification", caller: "member-service" });
  return async (ctx, target) => {
    await client.post<unknown, notification.NotifyRequest>(ctx, "/notify", buildEventInvite(target));
  };
}
