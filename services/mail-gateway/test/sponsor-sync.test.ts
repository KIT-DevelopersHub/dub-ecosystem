// スポンサーのメール連携 (mail-gateway 側): 人が送った / 受け取ったメールだけを member-service に知らせ、
// 失敗してもメールは失敗させないこと。集計 (POST /internal/sponsor/contacts) が人の送信・自動応答以外の受信だけを
// 相手アドレスごとに数えること。
import { describe, expect, it } from "vitest";
import type { sponsor } from "@dub/types";
import { sendMail } from "../src/send";
import { handleInbound } from "../src/inbound";
import { createApp } from "../src/app";
import type { RawInbound } from "../src/mime";
import { isAutoReply, querySponsorContacts, type SponsorSyncPort } from "../src/sponsor-sync";
import { inboundDeps, makeEnv, makeHarness, sendDeps } from "./helpers";

function recordingPort(fail = false): SponsorSyncPort & { notices: sponsor.MailActivityNotice[] } {
  const notices: sponsor.MailActivityNotice[] = [];
  return {
    notices,
    async notify(_ctx, n) {
      notices.push(n);
      if (fail) throw new Error("member-service down");
    },
  };
}

const req = { to: [{ email: "Yamada@A.example.jp" }], cc: [{ email: "suzuki@developershub.jp" }, { email: "sato@a.example.jp" }], subject: "協賛のご相談", textBody: "本文" };

function inbound(id: string, from: string, headers: Record<string, string> = {}, to = "info@developershub.jp"): RawInbound {
  return {
    from,
    to,
    headers: { "message-id": `<${id}@a.example.jp>`, from, to, subject: "Re: 協賛", date: "Mon, 2 Nov 2026 10:00:00 +0900", ...headers },
    rawText: "Subject: Re\r\n\r\nありがとうございます",
    rawSize: 100,
  };
}

describe("sponsor sync — send", () => {
  it("notifies a human send with its external To + Cc (archive / our domain dropped) and the From mailbox", async () => {
    const h = makeHarness();
    const port = recordingPort();
    await sendMail(sendDeps(h, { sponsor: port, archiveCc: "archive@developershub.jp", fromAddress: "suzuki@developershub.jp" }), req, "k1", "usr_alice");
    expect(port.notices).toHaveLength(1);
    expect(port.notices[0]).toMatchObject({ direction: "sent", counterparts: ["yamada@a.example.jp", "sato@a.example.jp"], mailbox: "suzuki@developershub.jp" });
    expect(Number.isNaN(Date.parse(port.notices[0]!.at))).toBe(false);
  });

  it("does not notify for system sends, failed sends, or idempotent replays", async () => {
    const h = makeHarness();
    const port = recordingPort();
    await sendMail(sendDeps(h, { sponsor: port, ownerUserId: null }), req, "sys", "notification");
    await sendMail(sendDeps(h, { sponsor: port }), req, "dup", "usr_alice");
    await sendMail(sendDeps(h, { sponsor: port }), req, "dup", "usr_alice");
    expect(port.notices).toHaveLength(1);
    const failing = makeHarness({ fail: true });
    await expect(sendMail(sendDeps(failing, { sponsor: port, retry: { maxAttempts: 1, baseDelayMs: 0 } }), req, "f", "usr_alice")).rejects.toThrow();
    expect(port.notices).toHaveLength(1);
  });

  it("a member-service outage never fails the send", async () => {
    const h = makeHarness();
    const port = recordingPort(true);
    const { status } = await sendMail(sendDeps(h, { sponsor: port }), req, "k2", "usr_alice");
    expect(status).toBe("sent");
    expect(h.provider.sent).toHaveLength(1);
    expect(port.notices).toHaveLength(1);
  });
});

describe("sponsor sync — inbound", () => {
  it("notifies the sender of a newly stored message once, never for auto-replies or our own domain", async () => {
    const h = makeHarness();
    const port = recordingPort();
    const deps = inboundDeps(h, { sponsor: port });
    await handleInbound(deps, inbound("m1", "Yamada@A.example.jp"));
    // 別の宛先のコピー / 再配送は知らせない。
    await handleInbound(deps, inbound("m1", "Yamada@A.example.jp", {}, "suzuki@developershub.jp"));
    await handleInbound(deps, inbound("m2", "yamada@a.example.jp", { "auto-submitted": "auto-replied" }));
    await handleInbound(deps, inbound("m3", "lead@developershub.jp"));
    expect(port.notices).toEqual([expect.objectContaining({ direction: "received", counterparts: ["yamada@a.example.jp"], mailbox: "info@developershub.jp" })]);
  });

  it("treats Auto-Submitted: no as a human mail and any loop marker as automatic", () => {
    expect(isAutoReply("no", null)).toBe(false);
    expect(isAutoReply(null, null)).toBe(false);
    expect(isAutoReply("auto-generated", null)).toBe(true);
    expect(isAutoReply(null, "1")).toBe(true);
  });
});

describe("sponsor sync — contacts query", () => {
  it("aggregates human sends (To + Cc) and non-automatic receipts per requested address only", async () => {
    const h = makeHarness();
    await sendMail(sendDeps(h), req, "s1", "usr_alice");
    await sendMail(sendDeps(h), { ...req, cc: [] }, "s2", "usr_alice");
    await sendMail(sendDeps(h, { ownerUserId: null }), { ...req, to: [{ email: "yamada@a.example.jp" }], cc: [] }, "sys", "notification");
    await handleInbound(inboundDeps(h), inbound("r1", "sato@a.example.jp"));
    await handleInbound(inboundDeps(h), inbound("r2", "sato@a.example.jp", { "auto-submitted": "auto-replied" }));
    await handleInbound(inboundDeps(h), inbound("r3", "x@a.example.jp"));

    const got = await querySponsorContacts(h.db, { addresses: ["yamada@a.example.jp", "sato@a.example.jp"] });
    const key = (c: sponsor.MailContactSummary) => `${c.direction}:${c.address}:${c.count}`;
    // システム送信・自動応答・頼んでいないアドレス (同じドメインの x@) は数えない。
    expect(got.map(key).sort()).toEqual(["received:sato@a.example.jp:1", "sent:sato@a.example.jp:1", "sent:yamada@a.example.jp:2"]);
    const yamada = got.find((c) => c.address === "yamada@a.example.jp")!;
    expect(yamada.firstAt <= yamada.lastAt).toBe(true);
  });

  it("is reachable only over the service binding and validates the body", async () => {
    const app = createApp();
    const { env } = makeEnv();
    const post = (body: unknown, internal: boolean) =>
      app.fetch(
        new Request("https://svc/internal/sponsor/contacts", {
          method: "POST",
          headers: { "content-type": "application/json", "x-dub-request-id": "r", ...(internal ? { "x-dub-internal": "1" } : {}) },
          body: JSON.stringify(body),
        }),
        env,
      );
    expect((await post({ addresses: [] }, false)).status).toBe(403);
    const ok = await post({ addresses: ["A@x.example.jp"] }, true);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ contacts: [] });
    expect((await post({ addresses: "nope" }, true)).status).toBe(400);
  });
});
