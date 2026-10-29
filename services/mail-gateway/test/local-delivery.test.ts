// Local delivery of internal recipients (local-delivery.ts): a send no longer depends on
// the provider -> MX -> Email Routing round trip for own-domain copies (Resend suppression).
import { describe, it, expect } from "vitest";
import { sendMail } from "../src/send";
import { handleInbound } from "../src/inbound";
import { deliverLocally, internalRecipients, mimeHeaderMap } from "../src/local-delivery";
import { listInbound } from "../src/repo";
import type { RawInbound } from "../src/mime";
import type { InboundDeps, SendDeps } from "../src/types";
import { fakeIdentityFetcher, inboundDeps, makeHarness, sendDeps, type Harness } from "./helpers";

const ARCHIVE = "archive@developershub.jp";
const ROSTER = {
  usr_alice: { email: "alice@developershub.jp" },
  usr_bob: { email: "bob@developershub.jp" },
  usr_carol: { email: "carol@developershub.jp" },
};

function setup(over: Partial<SendDeps> = {}): { h: Harness; inbound: InboundDeps; deps: SendDeps } {
  const h = makeHarness();
  const inbound = inboundDeps(h, { identity: fakeIdentityFetcher(true, ROSTER) });
  const deps = sendDeps(h, {
    fromAddress: "alice@developershub.jp",
    archiveCc: ARCHIVE,
    localDelivery: { inbound, domain: "developershub.jp" },
    ...over,
  });
  return { h, inbound, deps };
}

const deliveries = (h: Harness) =>
  h.raw.prepare(`SELECT envelope_to, owner_user_id FROM mail_inbound_delivery ORDER BY envelope_to`).all() as {
    envelope_to: string;
    owner_user_id: string | null;
  }[];
const inboundCount = (h: Harness) => (h.raw.prepare(`SELECT COUNT(*) AS c FROM mail_inbound`).get() as { c: number }).c;
const received = (h: Harness) => h.mailAuto.sends.filter((e) => e.name === "mail.message.received");

/** The copy Email Routing would hand email() for `rcpt`, built from what the provider got. */
function routedCopy(h: Harness, rcpt: string, extraHeaders: Record<string, string> = {}): RawInbound {
  const mime = h.provider.sent.at(-1)!.mime;
  return { from: "alice@developershub.jp", to: rcpt, headers: { ...mimeHeaderMap(mime), ...extraHeaders }, rawText: mime, rawSize: mime.length };
}

describe("local delivery after send", () => {
  it("To external + Cc internal: the Cc'd roster user has it in their inbox with no email() call", async () => {
    const { h, deps } = setup();
    const { response } = await sendMail(deps, { to: [{ email: "x@partner.example" }], cc: [{ email: "bob@developershub.jp" }], subject: "Quote", textBody: "hello bob" }, "k1", "test");

    expect(inboundCount(h)).toBe(1);
    expect(deliveries(h)).toEqual([
      { envelope_to: ARCHIVE, owner_user_id: null }, // archive copy: owner NULL (read_all only)
      { envelope_to: "bob@developershub.jp", owner_user_id: "usr_bob" },
    ]);
    const bob = await listInbound(h.db, { ownerUserId: "usr_bob", limit: 50 });
    expect(bob.items.map((m) => m.messageId)).toEqual([response.messageId]);
    expect(bob.items[0]!.subject).toBe("Quote");
    // Provider still got every recipient (normal Cc for external clients; archive as Bcc).
    const out = h.provider.sent[0]!;
    expect(out.cc.map((a) => a.email)).toEqual(["bob@developershub.jp"]);
    expect(out.bcc?.map((a) => a.email)).toEqual([ARCHIVE]);
    expect(received(h)).toHaveLength(1);
  });

  it("a later Email Routing redelivery of the same copy is a no-op (no rows, no event)", async () => {
    const { h, deps, inbound } = setup();
    await sendMail(deps, { to: [{ email: "x@partner.example" }], cc: [{ email: "bob@developershub.jp" }], subject: "Quote", textBody: "hi" }, "k2", "test");
    const before = { rows: inboundCount(h), deliveries: deliveries(h), events: received(h).length };

    const first = await handleInbound(inbound, routedCopy(h, "bob@developershub.jp"));
    const archive = await handleInbound(inbound, routedCopy(h, ARCHIVE));
    const again = await handleInbound(inbound, routedCopy(h, "bob@developershub.jp"));

    expect([first.processed, archive.processed, again.processed]).toEqual([false, false, false]);
    expect({ rows: inboundCount(h), deliveries: deliveries(h), events: received(h).length }).toEqual(before);
    // Exactly one real arrival is reported first (keeps the archive forward to once per id).
    expect([first.firstArrival, archive.firstArrival, again.firstArrival]).toEqual([true, undefined, undefined]);
  });

  it("the first real arrival swaps in real delivery details and drops the internal marker", async () => {
    const { h, deps, inbound } = setup();
    await sendMail(deps, { to: [{ email: "bob@developershub.jp" }], subject: "s", textBody: "b" }, "k3", "test");
    const stored = () => (h.raw.prepare(`SELECT header_meta_json FROM mail_inbound`).get() as { header_meta_json: string }).header_meta_json;
    expect(JSON.parse(stored()).localDelivery).toBe(true);
    await handleInbound(inbound, routedCopy(h, "bob@developershub.jp", { received: "from smtp.resend.com by mx.cloudflare.net with ESMTPS; now" }));
    const meta = JSON.parse(stored());
    expect(meta.localDelivery).toBeUndefined();
    expect(meta.tls).toBe(true);
  });

  it("Bcc internal: delivered, and the Bcc address is not in the stored headers", async () => {
    const { h, deps } = setup();
    await sendMail(deps, { to: [{ email: "x@partner.example" }], bcc: [{ email: "carol@developershub.jp" }], subject: "s", textBody: "b" }, "k4", "test");
    expect(deliveries(h)).toContainEqual({ envelope_to: "carol@developershub.jp", owner_user_id: "usr_carol" });
    const carol = await listInbound(h.db, { ownerUserId: "usr_carol", limit: 50 });
    expect(carol.items).toHaveLength(1);
    const visible = [...carol.items[0]!.to, ...(carol.items[0]!.cc ?? [])].map((a) => a.email);
    expect(visible).not.toContain("carol@developershub.jp");
    expect(h.provider.sent[0]!.mime.toLowerCase()).not.toContain("carol@developershub.jp");
  });

  it("Cc'ing yourself puts it in your own inbox too (Gmail-like); external-only sends store nothing", async () => {
    const { h, deps } = setup({ archiveCc: "" });
    await sendMail(deps, { to: [{ email: "x@partner.example" }], cc: [{ email: "alice@developershub.jp" }], subject: "s", textBody: "b" }, "k5", "test");
    expect(deliveries(h)).toEqual([{ envelope_to: "alice@developershub.jp", owner_user_id: "usr_alice" }]);

    const other = setup({ archiveCc: "" });
    await sendMail(other.deps, { to: [{ email: "x@partner.example" }], subject: "s", textBody: "b" }, "k6", "test");
    expect(inboundCount(other.h)).toBe(0);
  });

  it("no localDelivery deps (canary) = provider round trip only", async () => {
    const { h, deps } = setup();
    delete deps.localDelivery;
    await sendMail(deps, { to: [{ email: "bob@developershub.jp" }], subject: "s", textBody: "b" }, "k7", "test");
    expect(inboundCount(h)).toBe(0);
  });

  it("a local ingest failure never fails the send; it is audited", async () => {
    const { h, deps } = setup();
    deps.localDelivery!.inbound = { ...deps.localDelivery!.inbound, events: { ...h.events, EVT_MAIL_AUTOMATION: { send: async () => { throw new Error("queue down"); } } as never } };
    const res = await sendMail(deps, { to: [{ email: "bob@developershub.jp" }], subject: "s", textBody: "b" }, "k8", "test");
    expect(res.status).toBe("sent");
    expect(h.auditQ.sends.map((a) => [a.payload.action, a.payload.result])).toContainEqual(["mail.message.local_delivery", "failure"]);
  });
});

describe("local delivery helpers", () => {
  it("internalRecipients keeps only the own domain, lowercased and deduped", () => {
    expect(
      internalRecipients([{ email: "Bob@DevelopersHub.jp" }, { email: "x@partner.example" }, { email: "bob@developershub.jp" }, { email: "a@sub.developershub.jp" }], "developershub.jp"),
    ).toEqual(["bob@developershub.jp"]);
  });

  it("deliverLocally is a no-op without internal recipients", async () => {
    const h = makeHarness();
    const out = await deliverLocally({ inbound: inboundDeps(h), domain: "developershub.jp" }, { from: "a@developershub.jp", mime: "Subject: x\r\n\r\nb", envelope: [{ email: "x@partner.example" }], messageId: "m@developershub.jp" });
    expect(out).toEqual({ delivered: [], failed: [] });
  });
});
