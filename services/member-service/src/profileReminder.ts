// 情報が足りない運営メンバー本人への催促 (in-app 通知)。
//
// 運営名簿から管理者が操作した時だけ送る。参加届の通知と違い best-effort ではなく、失敗は
// 操作した管理者へそのまま返す (送れたと誤解させない)。dedupKey を日付で区切るので、
// 同じ人へ同じ日に重ねて押しても通知は 1 件に保たれる。
import type { Fetcher } from "@cloudflare/workers-types";
import { createServiceClient, type RequestContext } from "@dub/http";
import { member, type notification } from "@dub/types";

export const PROFILE_REMINDER_TYPE = "member.profile_reminder";

export interface ProfileReminderTarget {
  memberId: string;
  identityUserId: string;
  missing: member.PersonProfileKey[];
  /** YYYY-MM-DD。1 日 1 回に絞る dedupKey の区切り。 */
  today: string;
}

export function buildProfileReminder(t: ProfileReminderTarget): notification.NotifyRequest {
  return {
    type: PROFILE_REMINDER_TYPE,
    recipientIds: [t.identityUserId],
    title: "運営名簿の情報を入力してください",
    body: [
      "次の項目が未入力です。",
      ...t.missing.map((k) => `・${member.PERSON_PROFILE_LABEL[k]}`),
      "",
      "右上の設定（歯車）から「アカウント設定」を開き、「本人の情報」に入力してください。",
    ].join("\n"),
    channels: ["in_app"],
    dedupKey: `${PROFILE_REMINDER_TYPE}:${t.memberId}:${t.today}`,
    resourceType: "member",
    resourceId: t.memberId,
  };
}

export function sendProfileReminderVia(svcNotification: Fetcher) {
  const client = createServiceClient(svcNotification, { service: "notification", caller: "member-service" });
  return async (ctx: RequestContext, target: ProfileReminderTarget): Promise<{ deduplicated: boolean }> => {
    const res = await client.post<{ notificationId: string; deduplicated: boolean }, notification.NotifyRequest>(
      ctx,
      "/notify",
      buildProfileReminder(target),
    );
    return { deduplicated: res.deduplicated };
  };
}
