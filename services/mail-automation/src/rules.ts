// Pure rule evaluation: priority-ascending, first-match, AND conditions.
import type { AutomationRule, InboundMail, RuleCondition } from "./types";
import { invalidRule } from "./errors";

function emailDomain(addr: string): string {
  const at = addr.lastIndexOf("@");
  return at >= 0 ? addr.slice(at + 1).toLowerCase() : "";
}

/** Values a condition field resolves to for a given message (any-match semantics). */
function fieldValues(field: RuleCondition["field"], mail: InboundMail): string[] {
  switch (field) {
    case "from":
      return [mail.from.email];
    case "to":
      return mail.to.map((t) => t.email);
    case "subject":
      return [mail.subject];
    case "body":
      return [mail.snippet]; // full body lives in gateway; snippet is the local signal
    case "listId":
      return [mail.headers?.["list-id"] ?? ""];
    case "eventTag":
      return [mail.headers?.["x-dub-event-tag"] ?? ""];
    default:
      return [];
  }
}

function matchOne(cond: RuleCondition, value: string): boolean {
  switch (cond.op) {
    case "equals":
      return value === cond.value;
    case "contains":
      return value.toLowerCase().includes(cond.value.toLowerCase());
    case "regex": {
      let re: RegExp;
      try {
        re = new RegExp(cond.value);
      } catch {
        throw invalidRule(`Invalid regex in condition: ${cond.value}`);
      }
      return re.test(value);
    }
    case "domain_is":
      return emailDomain(value) === cond.value.toLowerCase();
    default:
      return false;
  }
}

export function conditionMatches(cond: RuleCondition, mail: InboundMail): boolean {
  return fieldValues(cond.field, mail).some((v) => matchOne(cond, v));
}

/** All conditions must match (AND). Empty conditions => never auto-matches (safe). */
export function ruleMatches(rule: AutomationRule, mail: InboundMail): boolean {
  if (rule.conditions.length === 0) return false;
  return rule.conditions.every((c) => conditionMatches(c, mail));
}

/**
 * First enabled rule (priority asc, then createdAt) whose conditions all match.
 * Returns null when nothing matches. Throws MAILAUTO_INVALID_RULE on bad regex.
 */
export function evaluateRules(rules: readonly AutomationRule[], mail: InboundMail): AutomationRule | null {
  const ordered = [...rules]
    .filter((r) => r.enabled)
    .sort((a, b) => (a.priority - b.priority) || a.createdAt.localeCompare(b.createdAt));
  for (const rule of ordered) {
    if (ruleMatches(rule, mail)) return rule;
  }
  return null;
}

/** Validate a rule's conditions/action at write time (regex compiles, non-empty). */
export function validateRuleShape(conditions: RuleCondition[], action: AutomationRule["action"]): void {
  if (conditions.length === 0) throw invalidRule("A rule needs at least one condition");
  for (const c of conditions) {
    if (c.op === "regex") {
      try {
        new RegExp(c.value);
      } catch {
        throw invalidRule(`Invalid regex: ${c.value}`);
      }
    }
  }
  if (action.type === "reply" && !action.templateId) throw invalidRule("reply action requires templateId");
  if (action.type === "route" && !action.assigneeUserId) throw invalidRule("route action requires assigneeUserId");
  if (action.type === "label" && !action.label) throw invalidRule("label action requires label");
}
