import { describe, it, expect } from "vitest";
import { DubError } from "@dub/errors";
import type { mail } from "@dub/types";
import { hashRequest, sendMail } from "../src/send";
import { findSendByKey } from "../src/repo";
import { handleInbound } from "../src/inbound";
import type { RawInbound } from "../src/mime";
import { makeHarness, sendDeps, inboundDeps } from "./helpers";

const baseReq: mail.SendMailRequest = {
  to: [{ email: "alice@example.com" }],
  subject: "Hello",
  textBody: "Body",
};

describe("sendMail — idempotency", () => {
  it("sends once, records the log, publishes mail.message.sent + audit success", async () => {
    const h = makeHarness();
    const deps = sendDeps(h);
    const { response, status } = await sendMail(deps, baseReq, "idem-1", "notification");

    expect(status).toBe("sent");
    expect(response.provider).toBe("resend");
    expect(response.messageId).toContain("@developershub.jp");
    expect(h.provider.sent).toHaveLength(1);

    const row = await findSendByKey(h.db, "idem-1");
    expect(row?.status).toBe("sent");
    expect(row?.provider_message_id).toContain("mock-");

    expect(h.notif.sends).toHaveLength(1);
    expect(h.notif.sends[0]!.name).toBe("mail.message.sent");
    expect((h.notif.sends[0]!.payload as { messageId: string }).messageId).toBe(response.messageId);

    expect(h.auditQ.sends).toHaveLength(1);
    expect(h.auditQ.sends[0]!.payload.action).toBe("mail.message.send");
    expect(h.auditQ.sends[0]!.payload.result).toBe("success");
  });

  it("returns duplicate on replay with the same key+body — only one email sent", async () => {
    const h = makeHarness();
    const deps = sendDeps(h);
    const first = await sendMail(deps, baseReq, "idem-2", "notification");
    const second = await sendMail(deps, baseReq, "idem-2", "notification");

    expect(second.status).toBe("duplicate");
    expect(second.response.messageId).toBe(first.response.messageId);
    expect(h.provider.sent).toHaveLength(1); // 二重送信ゼロ
    expect(h.notif.sends).toHaveLength(1); // event not re-published
  });

  it("threads a reply onto the ROOT thread of the message it answers, not the parent id (改善#4)", async () => {
    const h = makeHarness();
    // Seed a 2-message inbound thread rooted at A: A opens it, B is a reply that references A.
    const inRaw = (id: string, refs?: string): RawInbound => ({
      from: "ext@outside.com",
      to: "info@developershub.jp",
      headers: {
        "message-id": `<${id}@outside.com>`,
        from: "Ext <ext@outside.com>",
        to: "info@developershub.jp",
        subject: "Re: topic",
        date: "Sat, 09 Aug 2026 05:00:00 +0000",
        ...(refs ? { references: refs } : {}),
      },
      rawText: `Message-ID: <${id}@outside.com>\r\n\r\nbody`,
      rawSize: 200,
    });
    await handleInbound(inboundDeps(h), inRaw("A"));
    await handleInbound(inboundDeps(h), inRaw("B", "<A@outside.com>"));

    // We reply to the DEEPER message B. The stored thread_id must be the root A, so the
    // reply folds into the same conversation (not orphaned under "B@outside.com").
    await sendMail(sendDeps(h), { ...baseReq, inReplyTo: "B@outside.com" }, "idem-reply", "usr_info");
    const row = await findSendByKey(h.db, "idem-reply");
    expect(row?.thread_id).toBe("A@outside.com");
  });

  it("409s when the same key is reused with a different body", async () => {
    const h = makeHarness();
    const deps = sendDeps(h);
    await sendMail(deps, baseReq, "idem-3", "notification");
    await expect(
      sendMail(deps, { ...baseReq, textBody: "different" }, "idem-3", "notification"),
    ).rejects.toMatchObject({ code: "MAIL_IDEMPOTENCY_CONFLICT", status: 409 });
    expect(h.provider.sent).toHaveLength(1);
  });

  it("hashRequest is stable and body-sensitive", () => {
    expect(hashRequest(baseReq)).toBe(hashRequest({ ...baseReq }));
    expect(hashRequest(baseReq)).not.toBe(hashRequest({ ...baseReq, subject: "x" }));
  });
});

describe("sendMail — provider failure", () => {
  it("marks failed, publishes mail.message.send_failed + audit failure, throws 502", async () => {
    const h = makeHarness({ fail: true });
    const deps = sendDeps(h);
    await expect(sendMail(deps, baseReq, "idem-fail", "notification")).rejects.toBeInstanceOf(DubError);

    const row = await findSendByKey(h.db, "idem-fail");
    expect(row?.status).toBe("failed");
    expect(row?.error_code).toBe("MAIL_PROVIDER_UNAVAILABLE");

    expect(h.notif.sends).toHaveLength(1);
    expect(h.notif.sends[0]!.name).toBe("mail.message.send_failed");
    expect(h.auditQ.sends[0]!.payload.result).toBe("failure");
  });

  it("records error_code MAIL_RATE_LIMITED on a provider 429 (so status can surface it)", async () => {
    const h = makeHarness({ rateLimit: true });
    const deps = sendDeps(h);
    await expect(sendMail(deps, baseReq, "idem-429", "notification")).rejects.toMatchObject({
      code: "MAIL_RATE_LIMITED",
      status: 429,
    });
    const row = await findSendByKey(h.db, "idem-429");
    expect(row?.status).toBe("failed");
    expect(row?.error_code).toBe("MAIL_RATE_LIMITED");
    expect(h.notif.sends[0]!.name).toBe("mail.message.send_failed");
    expect((h.notif.sends[0]!.payload as { error: string }).error).toBe("MAIL_RATE_LIMITED");
  });

  it("allows a later retry on the same key after a failure (recovers to sent)", async () => {
    const h = makeHarness({ fail: true });
    const deps = sendDeps(h);
    await expect(sendMail(deps, baseReq, "idem-retry", "notification")).rejects.toBeTruthy();
    h.provider.setFail(false);
    const retry = await sendMail(deps, baseReq, "idem-retry", "notification");
    expect(retry.status).toBe("sent");
    expect(h.provider.sent).toHaveLength(1);
    const row = await findSendByKey(h.db, "idem-retry");
    expect(row?.status).toBe("sent");
  });
});

describe("sendMail — threading", () => {
  it("stores threadId from inReplyTo and stamps In-Reply-To into the MIME", async () => {
    const h = makeHarness();
    const deps = sendDeps(h);
    await sendMail(deps, { ...baseReq, inReplyTo: "orig-msg@example.com" }, "idem-thread", "mail-automation");
    const row = await findSendByKey(h.db, "idem-thread");
    expect(row?.thread_id).toBe("orig-msg@example.com");
    expect(h.provider.sent[0]!.mime).toContain("In-Reply-To: <orig-msg@example.com>");
  });
});
