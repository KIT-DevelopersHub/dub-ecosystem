// mailAutomation — mail-automation namespace. Same 2-stage posture as mail.
import type { ISODateTime, EventId } from "./common";

// ---- ① frozen ----
export type MailAutomationDecision = "route" | "reply" | "ignore" | "escalate";
export interface MailAutomationRule {
  id: string;
  match: string; // matcher expression
  decision: MailAutomationDecision;
  enabled: boolean;
}
export interface MailAutomationOutcome {
  ruleId: string | null;
  decision: MailAutomationDecision;
  decidedAt: ISODateTime;
}

// ---- ② STUB: 未決B(9-B)解決後に確定 ----
export interface MailAutomationWatch {
  id: string; // STUB
}

// ---- query contracts (previously undocumented in type + spec; the server reads them) ----
export interface ListRulesQuery {
  enabled?: boolean;
  eventId?: EventId;
}
export interface ListDecisionsQuery {
  messageId?: string;
  ruleId?: string;
  outcome?: string; // decision outcome filter (open string; server casts to its enum)
  limit?: number;
}

// ── Wire contract (query params) ─────────────────────────────────────────────
// SINGLE source of truth for the query-parameter *names* mail-automation's read endpoints
// put on the wire. The server (mail-automation app.ts) and the OpenAPI spec
// (docs/openapi/mail-automation.yaml) are reconciled against this map in CI (see
// @dub/e2e-smoke wire-params.test.ts). Renaming a key here is the only legitimate way to
// change a wire param. See docs/api-contracts/_wire-contract-enforcement.md.
export const MAIL_AUTOMATION_WIRE = {
  listRules: { method: "GET", path: "/rules", query: ["enabled", "eventId"] },
  listDecisions: { method: "GET", path: "/decisions", query: ["messageId", "ruleId", "outcome", "limit"] },
} as const;

// Compile-time tie: each endpoint's query keys must be real keys of its query type.
type _MailAutomationWireKeysAreTyped =
  (typeof MAIL_AUTOMATION_WIRE.listRules.query)[number] extends keyof ListRulesQuery
    ? (typeof MAIL_AUTOMATION_WIRE.listDecisions.query)[number] extends keyof ListDecisionsQuery
      ? true
      : never
    : never;
const _mailAutomationWireKeyGuard: _MailAutomationWireKeysAreTyped = true;
void _mailAutomationWireKeyGuard;
