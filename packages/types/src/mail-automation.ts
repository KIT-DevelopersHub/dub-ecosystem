// mailAutomation — mail-automation namespace. Same 2-stage posture as mail.
import type { ISODateTime } from "./common";

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
