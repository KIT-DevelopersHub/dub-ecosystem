// 面談の案内メール (本文は純粋関数) と、mail-gateway / notification への送り口。
// mail-gateway の /send は x-dub-user-id があると本人の mail:send を要求するので、システム送信として
// ユーザー無しで呼ぶ。POST /notify も同じ形にそろえる。
import type { Fetcher } from "@cloudflare/workers-types";
import { createServiceClient } from "@dub/http";
import { hrInterview, type mail, type notification } from "@dub/types";

const SENDER = "DevelopersHub 人事チーム";

export interface HrMailRequest {
  to: string;
  subject: string;
  textBody: string;
}
export type HrMailSender = (requestId: string, mail: HrMailRequest, idempotencyKey: string) => Promise<void>;
export type InterviewerNotifier = (requestId: string, req: notification.NotifyRequest) => Promise<void>;

/** 申し込みの自動返信。日程選択 URL を載せる。 */
export function renderInviteMail(name: string, email: string, url: string): HrMailRequest {
  return {
    to: email,
    subject: "【DevelopersHub】面談のお申し込みありがとうございます",
    textBody: [
      `${name} 様`,
      "",
      "DevelopersHub の面談にお申し込みいただき、ありがとうございます。",
      "下の URL から、ご都合のよい面談日程をお選びください。",
      "",
      url,
      "",
      "この URL はあなた専用です。他の方には共有しないでください。",
      "このメールに心当たりがない場合は、破棄してください。",
      "",
      SENDER,
    ].join("\n"),
  };
}

export function renderBookedMail(name: string, email: string, slot: { startAt: string; endAt: string }): HrMailRequest {
  return {
    to: email,
    subject: "【DevelopersHub】面談の日程が確定しました",
    textBody: [
      `${name} 様`,
      "",
      "面談の日程を次のとおり承りました。",
      "",
      `日時: ${hrInterview.formatSlotJst(slot)}（日本時間）`,
      "",
      "面談の場所や参加方法は、担当者からご連絡します。",
      "日程の変更が必要な場合は、このメールに返信してください。",
      "",
      SENDER,
    ].join("\n"),
  };
}

export function buildBookedNotify(slot: { id: string; startAt: string; endAt: string; interviewerId: string; bookedAt: string }, applicantName: string): notification.NotifyRequest {
  return {
    type: "member.hr_interview.booked",
    recipientIds: [slot.interviewerId],
    title: `面談の予約: ${applicantName}`,
    body: `${hrInterview.formatSlotJst(slot)}（日本時間）`,
    channels: ["in_app"],
    dedupKey: `hr-interview-booked:${slot.id}:${slot.bookedAt}`,
    resourceType: "hr_interview_slot",
    resourceId: slot.id,
  };
}

export function sendHrMailVia(svcMailGateway: Fetcher): HrMailSender {
  const client = createServiceClient(svcMailGateway, { service: "mail-gateway", caller: "member-service" });
  return async (requestId, m, idempotencyKey) => {
    await client.post<mail.SendMailResponse, mail.SendMailRequest>(
      { requestId },
      "/send",
      { to: [{ email: m.to }], subject: m.subject, textBody: m.textBody },
      { idempotencyKey },
    );
  };
}

export function interviewerNotifierVia(svcNotification: Fetcher): InterviewerNotifier {
  const client = createServiceClient(svcNotification, { service: "notification", caller: "member-service" });
  return async (requestId, req) => {
    await client.post<unknown, notification.NotifyRequest>({ requestId }, "/notify", req);
  };
}
