// Request validation for the Email Routing admin surface. Kept separate from the CF
// client so the anti-spoof / naming / limit rules are unit-testable in isolation.
//
// Design intent (theme#15 "なりすまし/スパム対策"):
//   - Address issuance and rule matchers are constrained to OUR zone apex, so an admin
//     cannot mint a rule that captures another domain's mail.
//   - Local parts follow a strict naming charset (no spaces / unicode tricks).
//   - Matcher/action/target counts are capped to leave room for abuse limits without a
//     schema change.
import { DubError } from "@dub/errors";
import type { CfRuleAction, CfRuleMatcher, CreateRuleInput, UpdateRuleInput } from "./email-routing";

export const ADDRESS_MAX_LEN = 254; // RFC 5321 max total email length
export const RULE_NAME_MAX_LEN = 255;
export const MAX_MATCHERS = 20;
export const MAX_ACTIONS = 20;
export const MAX_TARGETS_PER_ACTION = 20;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Local part: lowercase, starts/ends alnum, inner dot/underscore/%+- allowed. Blocks
// spaces, uppercase, and unicode look-alikes used for spoofing/abuse.
const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._%+-]*[a-z0-9])?$/;

function bad(message: string): never {
  throw new DubError("MAIL_INVALID_REQUEST", message, { status: 400 });
}

function isEmail(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= ADDRESS_MAX_LEN && EMAIL_RE.test(v);
}

function domainOf(email: string): string {
  return (email.split("@")[1] ?? "").toLowerCase();
}
function localOf(email: string): string {
  return email.split("@")[0] ?? "";
}

/**
 * Issue a receiving address: the admin supplies only a local part; the full address is
 * derived from our own zone and the forward target is fixed (the mail Worker), so there
 * is no destination to validate. Anti-spoof holds automatically — the address is always
 * `${localPart}@${zoneName}`.
 */
export function parseIssueAddressRequest(body: unknown, zoneName: string): { localPart: string; address: string } {
  const o = body as { localPart?: unknown } | null;
  if (!o || typeof o !== "object") bad("request body must be a JSON object");
  if (typeof o!.localPart !== "string" || o!.localPart.trim().length === 0) bad("`localPart` is required");
  const localPart = (o!.localPart as string).trim().toLowerCase();
  if (!LOCAL_PART_RE.test(localPart)) {
    bad("local part must be lowercase alphanumeric with . _ % + - (no spaces)");
  }
  const address = `${localPart}@${zoneName.toLowerCase()}`;
  if (address.length > ADDRESS_MAX_LEN) bad(`address too long (max ${ADDRESS_MAX_LEN})`);
  return { localPart, address };
}

/** Update an issued address: only the enable/disable toggle is mutable (the forward target
 *  is fixed to the mail Worker, so a destination change is not accepted here). */
export function parseUpdateIssuedAddressRequest(body: unknown): { enabled: boolean } {
  const o = body as { enabled?: unknown } | null;
  if (!o || typeof o !== "object") bad("request body must be a JSON object");
  return { enabled: mustBool(o!.enabled, "enabled") };
}

/** Destination address to create (a forward target — any domain, e.g. a personal inbox). */
export function parseCreateAddressRequest(body: unknown): { email: string } {
  const o = body as { email?: unknown } | null;
  if (!o || typeof o !== "object") bad("request body must be a JSON object");
  if (!isEmail(o!.email)) bad("`email` must be a valid email address");
  return { email: (o!.email as string).trim() };
}

/** A rule matcher: catch-all, or a literal `to` in our own zone with a strict local part. */
function parseMatcher(raw: unknown, zoneName: string): CfRuleMatcher {
  const m = raw as { type?: unknown; field?: unknown; value?: unknown } | null;
  if (!m || typeof m !== "object") bad("each matcher must be an object");
  if (m!.type === "all") return { type: "all" };
  if (m!.type !== "literal") bad('matcher.type must be "literal" or "all"');
  if (m!.field !== "to") bad('literal matcher.field must be "to"');
  if (!isEmail(m!.value)) bad("literal matcher.value must be a valid email address");
  const value = (m!.value as string).toLowerCase();
  if (domainOf(value) !== zoneName.toLowerCase()) {
    bad(`matcher address must be in the managed zone (@${zoneName})`);
  }
  if (!LOCAL_PART_RE.test(localOf(value))) {
    bad("matcher local part must be lowercase alphanumeric with . _ % + - (no spaces)");
  }
  return { type: "literal", field: "to", value };
}

/** A rule action: forward to verified destinations, hand to a worker, or drop. */
function parseAction(raw: unknown): CfRuleAction {
  const a = raw as { type?: unknown; value?: unknown } | null;
  if (!a || typeof a !== "object") bad("each action must be an object");
  if (a!.type === "drop") return { type: "drop" };
  if (a!.type !== "forward" && a!.type !== "worker") bad('action.type must be "forward", "worker" or "drop"');
  if (!Array.isArray(a!.value) || a!.value.length === 0) bad(`${a!.type} action requires a non-empty value array`);
  if ((a!.value as unknown[]).length > MAX_TARGETS_PER_ACTION) bad(`action has too many targets (max ${MAX_TARGETS_PER_ACTION})`);
  const value = (a!.value as unknown[]).map((v) => {
    if (a!.type === "forward") {
      if (!isEmail(v)) bad("forward action targets must be valid email addresses");
      return (v as string).trim();
    }
    if (typeof v !== "string" || v.length === 0) bad("worker action targets must be non-empty strings");
    return v as string;
  });
  return { type: a!.type as "forward" | "worker", value };
}

function parseMatchers(raw: unknown, zoneName: string): CfRuleMatcher[] {
  if (!Array.isArray(raw) || raw.length === 0) bad("`matchers` must be a non-empty array");
  if ((raw as unknown[]).length > MAX_MATCHERS) bad(`too many matchers (max ${MAX_MATCHERS})`);
  return (raw as unknown[]).map((m) => parseMatcher(m, zoneName));
}
function parseActions(raw: unknown): CfRuleAction[] {
  if (!Array.isArray(raw) || raw.length === 0) bad("`actions` must be a non-empty array");
  if ((raw as unknown[]).length > MAX_ACTIONS) bad(`too many actions (max ${MAX_ACTIONS})`);
  return (raw as unknown[]).map(parseAction);
}
function parseName(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) bad("`name` is required");
  if (raw.length > RULE_NAME_MAX_LEN) bad(`name too long (max ${RULE_NAME_MAX_LEN})`);
  return raw;
}
function parsePriority(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) bad("`priority` must be a non-negative integer");
  return raw;
}

export function parseCreateRuleRequest(body: unknown, zoneName: string): CreateRuleInput {
  const o = body as Record<string, unknown> | null;
  if (!o || typeof o !== "object") bad("request body must be a JSON object");
  const out: CreateRuleInput = {
    name: parseName(o!.name),
    enabled: o!.enabled === undefined ? true : mustBool(o!.enabled, "enabled"),
    matchers: parseMatchers(o!.matchers, zoneName),
    actions: parseActions(o!.actions),
  };
  const priority = parsePriority(o!.priority);
  if (priority !== undefined) out.priority = priority;
  return out;
}

export function parseUpdateRuleRequest(body: unknown, zoneName: string): UpdateRuleInput {
  const o = body as Record<string, unknown> | null;
  if (!o || typeof o !== "object") bad("request body must be a JSON object");
  const out: UpdateRuleInput = {};
  if (o!.name !== undefined) out.name = parseName(o!.name);
  if (o!.enabled !== undefined) out.enabled = mustBool(o!.enabled, "enabled");
  if (o!.matchers !== undefined) out.matchers = parseMatchers(o!.matchers, zoneName);
  if (o!.actions !== undefined) out.actions = parseActions(o!.actions);
  const priority = parsePriority(o!.priority);
  if (priority !== undefined) out.priority = priority;
  if (Object.keys(out).length === 0) bad("update must change at least one field");
  return out;
}

function mustBool(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") bad(`\`${field}\` must be a boolean`);
  return v as boolean;
}
