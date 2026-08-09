// Service-local domain model for mail-automation.
//
// NOTE on contract posture: the P0a design draft proposed a *rich* set of types
// (RuleCondition/RuleAction/AutomationRule/MailTemplate/DecisionOutcome/…) for the
// `@dub/types` `mailAutomation` namespace, to be frozen after P0b review. In the
// frozen foundation those additions did NOT land — `@dub/types` mailAutomation is
// still the thin ①-group (MailAutomationRule with a `match` string + a 4-way
// `decision`). Per the build rules we DO NOT re-open/modify frozen foundation
// packages, so the richer model the design specifies lives here as the service's
// internal domain model. Wire payloads we emit still conform to the frozen
// `@dub/events` payload map (thin), see publisher.ts.
import type { mail } from "@dub/types";

// ---- inbound message (superset of the frozen mail.MailMessage) ----
// The frozen mail.MailMessage lacks mailbox / raw headers / references, which the
// design's loop-prevention + send contract require. We extend it locally; the
// integration wave (post-9-B) reconciles this with the mail-gateway contract.
export interface InboundMail extends mail.MailMessage {
  /** Receiving mailbox address; defaults to first recipient when absent. */
  mailbox?: string;
  /** Lower-cased raw header map used by loop detection. */
  headers?: Record<string, string>;
  /** RFC References chain (thread depth signal). */
  references?: string[];
}

// ---- rules ----
export type RuleConditionField = "from" | "to" | "subject" | "body" | "listId" | "eventTag";
export type RuleConditionOp = "equals" | "contains" | "regex" | "domain_is";

export interface RuleCondition {
  field: RuleConditionField;
  op: RuleConditionOp;
  value: string;
}

export type RuleAction =
  | { type: "reply"; templateId: string }
  | { type: "route"; assigneeUserId: string; note?: string }
  | { type: "label"; label: string }
  | { type: "ignore" };

export interface AutomationRule {
  id: string;
  name: string;
  enabled: boolean; // default false (opt-in)
  priority: number; // lower runs first; first match wins
  conditions: RuleCondition[]; // AND
  action: RuleAction;
  eventId: string | null;
  rateLimitPerRecipientPerDay: number; // 0 = rule disabled-equivalent
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface MailTemplate {
  id: string;
  name: string;
  subject: string; // may contain {{var}}
  body: string;
  variables: string[]; // declared vars (render-time completeness check)
  createdAt: string;
  updatedAt: string;
}

// ---- decisions ----
export type DecisionOutcome =
  | "replied"
  | "routed"
  | "labeled"
  | "ignored_no_match"
  | "suppressed_loop"
  | "suppressed_rate"
  | "suppressed_disabled"
  | "suppressed_duplicate"
  | "error";

export interface DecisionRecord {
  id: string;
  gatewayMessageId: string;
  threadId: string;
  fromAddr: string;
  outcome: DecisionOutcome;
  matchedRuleId: string | null;
  sentMessageId: string | null;
  suppressReasons: string[];
  decidedAt: string;
}

// ---- API DTOs ----
export interface ProcessRequest {
  mail: InboundMail;
  force?: boolean;
}
export interface ProcessResponse {
  decisionId: string;
  outcome: DecisionOutcome;
  matchedRuleId: string | null;
  sentMessageId: string | null;
}

export interface DryRunRequest {
  mail: InboundMail;
}
export interface DryRunResponse {
  wouldMatch: AutomationRule | null;
  wouldOutcome: DecisionOutcome;
  renderedReply: { subject: string; body: string } | null;
  suppressReasons: string[];
}

export interface AutomationSettings {
  automationEnabled: boolean; // global kill switch (initial false)
  maxRepliesPerThread: number; // default 2
  defaultRatePerRecipientPerDay: number; // default 5
}

export const DEFAULT_SETTINGS: AutomationSettings = {
  automationEnabled: false,
  maxRepliesPerThread: 2,
  defaultRatePerRecipientPerDay: 5,
};

// ---- create/update inputs ----
export interface CreateRuleInput {
  name: string;
  enabled?: boolean;
  priority?: number;
  conditions: RuleCondition[];
  action: RuleAction;
  eventId?: string | null;
  rateLimitPerRecipientPerDay?: number;
}
export type UpdateRuleInput = Partial<Omit<AutomationRule, "id" | "createdBy" | "createdAt" | "updatedAt">>;

export interface CreateTemplateInput {
  name: string;
  subject: string;
  body: string;
  variables?: string[];
}
export type UpdateTemplateInput = Partial<Omit<MailTemplate, "id" | "createdAt" | "updatedAt">>;

export interface RuleFilter {
  enabled?: boolean;
  eventId?: string;
}
export interface DecisionFilter {
  messageId?: string;
  ruleId?: string;
  outcome?: DecisionOutcome;
  limit?: number;
}
