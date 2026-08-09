import { describe, it, expect } from "vitest";
import { processInbound, dryRun } from "../src/pipeline";
import type { MailAutoRepo } from "../src/repo";
import type { RuleAction } from "../src/types";
import { makeDeps, inbound, type DepsBundle } from "./fakes";
import type { RunContext } from "../src/publisher";

const RUN: RunContext = { requestId: "req_1", actorId: null };

async function seedReplyRule(repo: MailAutoRepo, over: { rate?: number; domain?: string; body?: string } = {}) {
  const tpl = await repo.createTemplate({ name: "ack", subject: "Re: {{subject}}", body: over.body ?? "Hi {{sender_name}}" });
  const action: RuleAction = { type: "reply", templateId: tpl.id };
  const rule = await repo.createRule(
    {
      name: "auto-ack",
      enabled: true,
      priority: 10,
      conditions: [{ field: "from", op: "domain_is", value: over.domain ?? "acme.io" }],
      action,
      rateLimitPerRecipientPerDay: over.rate ?? 5,
    },
    "creator",
  );
  return { tpl, rule };
}

async function enable(b: DepsBundle) {
  await b.repo.updateSettings({ automationEnabled: true }, "admin");
}

describe("kill switch", () => {
  it("automationEnabled=false suppresses everything", async () => {
    const b = makeDeps();
    await seedReplyRule(b.repo);
    const res = await processInbound(b.deps, inbound({ from: { email: "a@acme.io" } }), {}, RUN);
    expect(res.outcome).toBe("suppressed_disabled");
    expect(b.gateway.sends).toHaveLength(0);
    expect(b.publisher.decided).toEqual([{ ruleId: null, decision: "suppressed_disabled" }]);
  });
});

describe("reply happy path + send contract", () => {
  it("replies and stamps idempotencyKey/mailbox/Auto-Submitted", async () => {
    const b = makeDeps();
    await enable(b);
    await seedReplyRule(b.repo);
    const mail = inbound({ from: { email: "a@acme.io" }, mailbox: "info@developershub.jp", subject: "Question" });
    const res = await processInbound(b.deps, mail, {}, RUN);

    expect(res.outcome).toBe("replied");
    expect(res.sentMessageId).toBe("gwsent_1");
    expect(b.gateway.sends).toHaveLength(1);
    const call = b.gateway.sends[0]!;
    expect(call.opts.idempotencyKey).toBe(`mailauto:${res.decisionId}`);
    expect(call.opts.mailbox).toBe("info@developershub.jp");
    expect(call.req.loopHeaders?.["auto-submitted"]).toBe("auto-replied");
    expect(call.req.inReplyTo).toBe(mail.messageId);
    expect(call.req.subject).toBe("Re: Question");
    // decided emitted, audit once
    expect(b.publisher.decided).toEqual([{ ruleId: expect.any(String), decision: "replied" }]);
    expect(b.audit.records).toHaveLength(1);
    expect(b.audit.records[0]!.action).toBe("mail.automation.decide");
  });
});

describe("loop prevention", () => {
  it.each([
    ["auto-submitted header", { "auto-submitted": "auto-generated" }],
    ["precedence bulk", { precedence: "bulk" }],
    ["list-id", { "list-id": "<l.x>" }],
  ])("suppresses on %s", async (_label, headers) => {
    const b = makeDeps();
    await enable(b);
    await seedReplyRule(b.repo);
    const res = await processInbound(b.deps, inbound({ from: { email: "a@acme.io" }, headers }), {}, RUN);
    expect(res.outcome).toBe("suppressed_loop");
    expect(b.gateway.sends).toHaveLength(0);
  });

  it("suppresses self-domain sender", async () => {
    const b = makeDeps();
    await enable(b);
    await seedReplyRule(b.repo, { domain: "developershub.jp" });
    const res = await processInbound(b.deps, inbound({ from: { email: "bot@developershub.jp" } }), {}, RUN);
    expect(res.outcome).toBe("suppressed_loop");
  });

  it("suppresses after maxRepliesPerThread reached", async () => {
    const b = makeDeps();
    await enable(b); // maxRepliesPerThread default 2
    await seedReplyRule(b.repo);
    const tid = "thread_shared";
    const r1 = await processInbound(b.deps, inbound({ id: "m1", threadId: tid, from: { email: "a@acme.io" } }), {}, RUN);
    const r2 = await processInbound(b.deps, inbound({ id: "m2", threadId: tid, from: { email: "a@acme.io" } }), {}, RUN);
    const r3 = await processInbound(b.deps, inbound({ id: "m3", threadId: tid, from: { email: "a@acme.io" } }), {}, RUN);
    expect(r1.outcome).toBe("replied");
    expect(r2.outcome).toBe("replied");
    expect(r3.outcome).toBe("suppressed_loop");
    expect(b.gateway.sends).toHaveLength(2);
  });
});

describe("rate limiting", () => {
  it("suppresses over daily cap and resets next day", async () => {
    const b = makeDeps();
    await enable(b);
    // cap = min(rule 2, global 5) = 2, but use distinct threads to isolate from thread guard
    await seedReplyRule(b.repo, { rate: 2 });
    const from = { email: "spammy@acme.io" };
    const day1 = [
      await processInbound(b.deps, inbound({ id: "d1", threadId: "t1", from }), {}, RUN),
      await processInbound(b.deps, inbound({ id: "d2", threadId: "t2", from }), {}, RUN),
      await processInbound(b.deps, inbound({ id: "d3", threadId: "t3", from }), {}, RUN),
    ];
    expect(day1.map((r) => r.outcome)).toEqual(["replied", "replied", "suppressed_rate"]);

    b.clock.setDay("2026-08-10");
    const nextDay = await processInbound(b.deps, inbound({ id: "d4", threadId: "t4", from }), {}, RUN);
    expect(nextDay.outcome).toBe("replied");
  });
});

describe("business idempotency", () => {
  it("second delivery of same gatewayMessageId => suppressed_duplicate, send once", async () => {
    const b = makeDeps();
    await enable(b);
    await seedReplyRule(b.repo);
    const mail = inbound({ id: "dup1", from: { email: "a@acme.io" } });
    const first = await processInbound(b.deps, mail, {}, RUN);
    const second = await processInbound(b.deps, mail, {}, RUN);
    expect(first.outcome).toBe("replied");
    expect(second.outcome).toBe("suppressed_duplicate");
    expect(b.gateway.sends).toHaveLength(1);
    // duplicate short-circuits: no extra decided/audit
    expect(b.publisher.decided).toHaveLength(1);
    expect(b.audit.records).toHaveLength(1);
  });

  it("force re-processes a duplicate", async () => {
    const b = makeDeps();
    await enable(b);
    await seedReplyRule(b.repo);
    const mail = inbound({ id: "dup2", from: { email: "a@acme.io" } });
    await processInbound(b.deps, mail, {}, RUN);
    const forced = await processInbound(b.deps, mail, { force: true }, RUN);
    expect(forced.outcome).toBe("replied");
    expect(b.gateway.sends).toHaveLength(2);
  });
});

describe("no match / route / label", () => {
  it("no matching rule => ignored_no_match", async () => {
    const b = makeDeps();
    await enable(b);
    await seedReplyRule(b.repo, { domain: "acme.io" });
    const res = await processInbound(b.deps, inbound({ from: { email: "x@other.io" } }), {}, RUN);
    expect(res.outcome).toBe("ignored_no_match");
  });

  it("route action emits routed + decided", async () => {
    const b = makeDeps();
    await enable(b);
    await b.repo.createRule(
      {
        name: "route-it",
        enabled: true,
        priority: 5,
        conditions: [{ field: "subject", op: "contains", value: "urgent" }],
        action: { type: "route", assigneeUserId: "user_ops", note: "handle" },
      },
      "creator",
    );
    const mail = inbound({ id: "rt1", subject: "URGENT issue", from: { email: "x@other.io" } });
    const res = await processInbound(b.deps, mail, {}, RUN);
    expect(res.outcome).toBe("routed");
    expect(b.publisher.routed).toEqual([{ messageId: "rt1" }]);
    expect(b.publisher.decided).toEqual([{ ruleId: res.matchedRuleId, decision: "routed" }]);
    expect(b.gateway.sends).toHaveLength(0);
  });
});

describe("template + gateway errors", () => {
  it("unresolved template variable => error, no send", async () => {
    const b = makeDeps();
    await enable(b);
    // body needs event_name but rule has no eventId and no eventClient => unresolved
    await seedReplyRule(b.repo, { body: "Hi {{sender_name}}, re {{event_name}}" });
    const res = await processInbound(b.deps, inbound({ from: { email: "a@acme.io" } }), {}, RUN);
    expect(res.outcome).toBe("error");
    expect(b.gateway.sends).toHaveLength(0);
    expect(b.audit.records[0]!.result).toBe("failure");
  });

  it("gateway 5xx => error decision persisted", async () => {
    const b = makeDeps({ failSend: true });
    await enable(b);
    await seedReplyRule(b.repo);
    const mail = inbound({ id: "ge1", from: { email: "a@acme.io" } });
    const res = await processInbound(b.deps, mail, {}, RUN);
    expect(res.outcome).toBe("error");
    const stored = await b.repo.findDecisionByGatewayMessageId("ge1");
    expect(stored?.outcome).toBe("error");
    expect(b.publisher.decided).toEqual([{ ruleId: expect.any(String), decision: "error" }]);
  });
});

describe("event_name resolution via event-service", () => {
  it("resolves {{event_name}} from eventClient", async () => {
    const b = makeDeps({ eventTitles: { evt_1: "Hackit 2026" } });
    await enable(b);
    const tpl = await b.repo.createTemplate({ name: "ev", subject: "Re", body: "About {{event_name}}" });
    await b.repo.createRule(
      {
        name: "ev-rule",
        enabled: true,
        priority: 1,
        conditions: [{ field: "from", op: "domain_is", value: "acme.io" }],
        action: { type: "reply", templateId: tpl.id },
        eventId: "evt_1",
      },
      "creator",
    );
    const res = await processInbound(b.deps, inbound({ from: { email: "a@acme.io" } }), {}, RUN);
    expect(res.outcome).toBe("replied");
    expect(b.gateway.sends[0]!.req.textBody).toBe("About Hackit 2026");
  });
});

describe("dry-run", () => {
  it("evaluates without sending or emitting", async () => {
    const b = makeDeps();
    await enable(b);
    await seedReplyRule(b.repo);
    const out = await dryRun(b.deps, inbound({ from: { email: "a@acme.io" }, subject: "Q" }), RUN);
    expect(out.wouldOutcome).toBe("replied");
    expect(out.wouldMatch?.name).toBe("auto-ack");
    expect(out.renderedReply?.subject).toBe("Re: Q");
    expect(b.gateway.sends).toHaveLength(0);
    expect(b.publisher.decided).toHaveLength(0);
    expect(b.audit.records).toHaveLength(0);
  });
});
