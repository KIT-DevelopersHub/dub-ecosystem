import { describe, it, expect } from "vitest";
import { evaluateRules, ruleMatches, validateRuleShape } from "../src/rules";
import { MailAutoErrorCodes } from "../src/errors";
import type { AutomationRule, RuleCondition } from "../src/types";
import { inbound } from "./fakes";

function rule(over: Partial<AutomationRule>): AutomationRule {
  return {
    id: over.id ?? "r1",
    name: over.name ?? "r",
    enabled: over.enabled ?? true,
    priority: over.priority ?? 100,
    conditions: over.conditions ?? [],
    action: over.action ?? { type: "ignore" },
    eventId: over.eventId ?? null,
    rateLimitPerRecipientPerDay: over.rateLimitPerRecipientPerDay ?? 5,
    createdBy: over.createdBy ?? "u",
    createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: over.updatedAt ?? "2026-01-01T00:00:00.000Z",
  };
}

describe("rule condition ops", () => {
  const mail = inbound({ from: { email: "alice@acme.io" }, subject: "Sponsorship inquiry", snippet: "we want to sponsor" });

  it("equals / contains / regex / domain_is", () => {
    const eq: RuleCondition = { field: "subject", op: "equals", value: "Sponsorship inquiry" };
    const ct: RuleCondition = { field: "body", op: "contains", value: "SPONSOR" };
    const rx: RuleCondition = { field: "subject", op: "regex", value: "^Sponsor" };
    const dm: RuleCondition = { field: "from", op: "domain_is", value: "acme.io" };
    expect(ruleMatches(rule({ conditions: [eq] }), mail)).toBe(true);
    expect(ruleMatches(rule({ conditions: [ct] }), mail)).toBe(true);
    expect(ruleMatches(rule({ conditions: [rx] }), mail)).toBe(true);
    expect(ruleMatches(rule({ conditions: [dm] }), mail)).toBe(true);
  });

  it("AND semantics: all conditions must match", () => {
    const r = rule({ conditions: [
      { field: "from", op: "domain_is", value: "acme.io" },
      { field: "subject", op: "contains", value: "unrelated" },
    ] });
    expect(ruleMatches(r, mail)).toBe(false);
  });

  it("empty conditions never auto-match (safe default)", () => {
    expect(ruleMatches(rule({ conditions: [] }), mail)).toBe(false);
  });
});

describe("evaluateRules ordering", () => {
  const mail = inbound({ subject: "match me" });

  it("priority ascending, first match wins", () => {
    const low = rule({ id: "low", priority: 10, conditions: [{ field: "subject", op: "contains", value: "match" }] });
    const high = rule({ id: "high", priority: 50, conditions: [{ field: "subject", op: "contains", value: "match" }] });
    expect(evaluateRules([high, low], mail)?.id).toBe("low");
  });

  it("disabled rules are skipped", () => {
    const disabled = rule({ id: "d", enabled: false, priority: 1, conditions: [{ field: "subject", op: "contains", value: "match" }] });
    const enabled = rule({ id: "e", enabled: true, priority: 2, conditions: [{ field: "subject", op: "contains", value: "match" }] });
    expect(evaluateRules([disabled, enabled], mail)?.id).toBe("e");
  });

  it("returns null when nothing matches", () => {
    expect(evaluateRules([rule({ conditions: [{ field: "subject", op: "equals", value: "nope" }] })], mail)).toBeNull();
  });
});

describe("validateRuleShape", () => {
  it("rejects empty conditions", () => {
    expect(() => validateRuleShape([], { type: "ignore" })).toThrowError();
  });
  it("rejects invalid regex with MAILAUTO_INVALID_RULE", () => {
    try {
      validateRuleShape([{ field: "subject", op: "regex", value: "(" }], { type: "ignore" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { code?: string }).code).toBe(MailAutoErrorCodes.INVALID_RULE);
    }
  });
  it("accepts a valid reply rule", () => {
    expect(() =>
      validateRuleShape([{ field: "from", op: "domain_is", value: "acme.io" }], { type: "reply", templateId: "t1" }),
    ).not.toThrow();
  });
});
