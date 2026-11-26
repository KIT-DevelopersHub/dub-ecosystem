// 新着メールの通知 (#869): 持ち主のいる配送ごとに 1 件、ブロック済み・自動送信・一斉配信は知らせない、
// 通知が落ちても受信は成功する。
import { describe, expect, it } from "vitest";
import type { notification } from "@dub/types";
import { handleInbound } from "../src/inbound";
import type { RawInbound } from "../src/mime";
import { buildNewMailNotify, isAutomatedMail, type NewMailNotifyPort } from "../src/new-mail-notify";
import { fakeIdentityFetcher, inboundDeps, makeHarness } from "./helpers";

const USERS = {
  usr_alice: { email: "alice@developershub.jp" },
  usr_bob: { email: "bob@developershub.jp" },
};

function recordingPort(fail = false): NewMailNotifyPort & { sent: notification.NotifyRequest[] } {
  const sent: notification.NotifyRequest[] = [];
  return {
    sent,
    async notify(_ctx, req) {
      sent.push(req);
      if (fail) throw new Error("notification down");
    },
  };
}

function inbound(id: string, to: string, headers: Record<string, string> = {}, from = "Yamada Taro <yamada@a.example.jp>"): RawInbound {
  return {
    from: "yamada@a.example.jp",
    to,
    headers: { "message-id": `<${id}@a.example.jp>`, from, to: "alice@developershub.jp, bob@developershub.jp", subject: "打ち合わせの件", date: "Mon, 2 Nov 2026 10:00:00 +0900", ...headers },
    rawText: "Subject: x\r\n\r\n来週の打ち合わせについてご相談です。",
    rawSize: 100,
  };
}

function deps(port: NewMailNotifyPort) {
  const h = makeHarness();
  return { h, deps: inboundDeps(h, { identity: fakeIdentityFetcher(true, USERS), newMailNotify: port }) };
}

describe("new-mail notification", () => {
  it("notifies each owning recipient once, linking to the stored message", async () => {
    const port = recordingPort();
    const { deps: d } = deps(port);
    const first = await handleInbound(d, inbound("m1", "alice@developershub.jp"));
    await handleInbound(d, inbound("m1", "bob@developershub.jp"));
    // Email Routing redelivery of alice's copy: no new delivery row -> no second notification.
    await handleInbound(d, inbound("m1", "alice@developershub.jp"));
    expect(port.sent.map((r) => r.recipientIds)).toEqual([["usr_alice"], ["usr_bob"]]);
    expect(port.sent[0]).toMatchObject({
      type: "mail.received",
      title: "Yamada Taro さんからメールが届きました",
      resourceType: "mail_message",
      resourceId: first.message.id,
      dedupKey: `mail.received:${first.message.id}:usr_alice`,
      channels: ["in_app"],
    });
    expect(port.sent[0]!.body).toContain("打ち合わせの件");
    expect(port.sent[1]!.resourceId).toBe(first.message.id);
  });

  it("skips auto-replies, bulk mail, the archive copy and unowned deliveries", async () => {
    const port = recordingPort();
    const { deps: d } = deps(port);
    await handleInbound(d, inbound("m2", "alice@developershub.jp", { "auto-submitted": "auto-replied" }));
    await handleInbound(d, inbound("m3", "alice@developershub.jp", { precedence: "bulk" }));
    await handleInbound(d, inbound("m4", "archive@developershub.jp"));
    await handleInbound(d, inbound("m5", "nobody@developershub.jp", { to: "nobody@developershub.jp" }));
    expect(port.sent).toEqual([]);
  });

  it("skips a sender the recipient blocked", async () => {
    const port = recordingPort();
    const { h, deps: d } = deps(port);
    await h.db.run(
      `INSERT INTO mail_sender_blocks (owner_user_id, kind, value, created_at) VALUES ('usr_alice', 'address', 'yamada@a.example.jp', '2026-11-01T00:00:00Z')`,
    );
    await handleInbound(d, inbound("m6", "alice@developershub.jp"));
    await handleInbound(d, inbound("m6", "bob@developershub.jp"));
    expect(port.sent.map((r) => r.recipientIds)).toEqual([["usr_bob"]]);
  });

  it("a notification outage never fails ingest", async () => {
    const port = recordingPort(true);
    const { deps: d } = deps(port);
    const res = await handleInbound(d, inbound("m7", "alice@developershub.jp"));
    expect(res.processed).toBe(true);
    expect(port.sent).toHaveLength(1);
  });

  it("builds a compact notice and classifies automated mail", () => {
    const req = buildNewMailNotify(
      { id: "mail_1", messageId: "x", threadId: "x", from: { email: "a@b.jp" }, to: [], subject: "", snippet: "", receivedAt: "2026-11-01T00:00:00Z" },
      "usr_alice",
    );
    expect(req.title).toBe("a@b.jp さんからメールが届きました");
    expect(req.body).toBe("（件名なし）");
    expect(isAutomatedMail({ "x-dub-mail-loop": "1" })).toBe(true);
    expect(isAutomatedMail({ precedence: "List" })).toBe(true);
    expect(isAutomatedMail({ "auto-submitted": "no" })).toBe(false);
  });
});
