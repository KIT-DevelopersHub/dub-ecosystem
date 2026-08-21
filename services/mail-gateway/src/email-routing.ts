// Cloudflare Email Routing API proxy client. Backs the /mail/admin/email-routing/*
// admin surface: issue @developershub.jp destination addresses and manage forwarding
// rules from the DevHub admin console instead of the Cloudflare dashboard.
//
// Two Cloudflare API scopes are involved (both under the same token):
//   - destination addresses are ACCOUNT-scoped:
//       /accounts/{account_id}/email/routing/addresses
//   - routing rules are ZONE-scoped:
//       /zones/{zone_id}/email/routing/rules
//
// Secret posture (mirrors resend.ts / ses.ts): the token lives ONLY in the Workers
// Secret CF_EMAIL_ROUTING_TOKEN. It is never committed, never logged, never echoed in
// an error body. When it is absent, `emailRoutingConfigFromEnv` returns null and callers
// answer 503 MAIL_EMAIL_ROUTING_UNCONFIGURED — the feature fails LOUD, never silent.
//
// Failure posture: any transport error / non-2xx / CF `success:false` becomes a
// DubError(MAIL_EMAIL_ROUTING_UPSTREAM, 502) carrying only Cloudflare's own error
// messages (which do not contain the token). A missing zone/account id for the
// requested operation is a 503 (mis-provisioned), distinct from a bad request (400).
import { DubError } from "@dub/errors";
import { DEFAULT_SEND_TIMEOUT_MS } from "./config";
import type { Env } from "./env";
import { parseTimeoutMs } from "./resilience";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

export interface EmailRoutingConfig {
  token: string;
  accountId?: string; // required for destination-address operations
  zoneId?: string; // required for rule operations
  zoneName: string; // zone apex (anti-spoof check on rule matchers)
  workerName: string; // Email Worker every issued receiving address routes to (Worker action)
  timeoutMs: number;
  fetchImpl?: typeof fetch; // injectable for tests; defaults to global fetch
}

// ---- Cloudflare wire shapes (subset we depend on) ----
export interface CfDestinationAddress {
  id: string;
  email: string;
  verified: string | null;
  created: string;
  modified: string;
  tag?: string;
}
export interface CfRuleMatcher {
  type: "literal" | "all";
  field?: "to";
  value?: string;
}
export interface CfRuleAction {
  type: "forward" | "worker" | "drop";
  value?: string[];
}
export interface CfRoutingRule {
  id: string;
  tag?: string;
  name: string;
  enabled: boolean;
  priority: number;
  matchers: CfRuleMatcher[];
  actions: CfRuleAction[];
}
/** One roster entry derived from a routing rule: the RECEIVING @zone address the rule
 *  matches on (its `to` literal matcher), the rule's first forward target as a
 *  destination hint, and the rule's enabled flag. This — NOT the account-scoped
 *  destination addresses — is what the user roster syncs from. */
export interface RosterEmailAddress {
  address: string; // receiving address, e.g. "account@developershub.jp"
  destination: string | null; // first forward target, or null (worker/drop/none)
  enabled: boolean;
}

/**
 * Extract the roster's receiving addresses from Cloudflare Email Routing RULES.
 *
 * The roster = the @zone addresses people RECEIVE at (issued as routing rules,
 * zone-scoped) — NOT the account-scoped destination (forward-target) addresses, of
 * which a domain typically has only one or two. Each rule contributes one entry per
 * `{type:'literal', field:'to', value:'x@zone'}` matcher whose address belongs to
 * `zoneName`. Catch-all (`type:'all'`) rules and non-@zone matchers are ignored.
 * De-duped by lowercased address (first occurrence wins; a later ENABLED occurrence
 * upgrades a previously-seen disabled one, so a paused duplicate never masks a live one).
 */
export function rosterAddressesFromRules(rules: CfRoutingRule[], zoneName: string): RosterEmailAddress[] {
  const suffix = `@${zoneName.trim().toLowerCase()}`;
  const byAddress = new Map<string, RosterEmailAddress>();
  for (const rule of rules ?? []) {
    const destination = firstForwardTarget(rule);
    for (const m of rule.matchers ?? []) {
      if (m.type !== "literal" || m.field !== "to" || typeof m.value !== "string") continue;
      const address = m.value.trim().toLowerCase();
      if (address.length <= suffix.length || !address.endsWith(suffix)) continue;
      const existing = byAddress.get(address);
      if (!existing) {
        byAddress.set(address, { address, destination, enabled: !!rule.enabled });
      } else if (rule.enabled && !existing.enabled) {
        byAddress.set(address, { address, destination: existing.destination ?? destination, enabled: true });
      }
    }
  }
  return [...byAddress.values()];
}

/** The first `forward` action's first target, or null (worker/drop actions have none). */
function firstForwardTarget(rule: CfRoutingRule): string | null {
  for (const a of rule.actions ?? []) {
    if (a.type === "forward" && Array.isArray(a.value) && a.value.length > 0) {
      return a.value[0] ?? null;
    }
  }
  return null;
}

/**
 * The Email Worker most existing rules route to — i.e. the shared inbox Worker new
 * addresses should join. Scans every rule's `worker` action targets and returns the most
 * frequent one (ties broken by first-seen), or null when no rule routes to a Worker. This
 * is what makes issuance "route to the SAME Worker as everyone else" without a human
 * typing a destination; callers fall back to the configured constant when it returns null.
 */
export function mostCommonWorkerTarget(rules: CfRoutingRule[]): string | null {
  const counts = new Map<string, number>();
  for (const rule of rules ?? []) {
    for (const a of rule.actions ?? []) {
      if (a.type !== "worker" || !Array.isArray(a.value)) continue;
      for (const target of a.value) {
        if (typeof target !== "string" || target.length === 0) continue;
        counts.set(target, (counts.get(target) ?? 0) + 1);
      }
    }
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [target, count] of counts) {
    if (count > bestCount) {
      best = target;
      bestCount = count;
    }
  }
  return best;
}

interface CfEnvelope<T> {
  success: boolean;
  errors: Array<{ code?: number; message?: string }>;
  messages: unknown[];
  result: T;
  result_info?: { page?: number; per_page?: number; count?: number; total_count?: number };
}

export interface CreateRuleInput {
  name: string;
  enabled: boolean;
  matchers: CfRuleMatcher[];
  actions: CfRuleAction[];
  priority?: number;
}
export type UpdateRuleInput = Partial<CreateRuleInput>;

/** Build the client config from Env, or null when the token secret is absent (→ 503). */
export function emailRoutingConfigFromEnv(env: Env): EmailRoutingConfig | null {
  const token = env.CF_EMAIL_ROUTING_TOKEN;
  if (typeof token !== "string" || token.length === 0) return null;
  return {
    token,
    accountId: env.CF_EMAIL_ROUTING_ACCOUNT_ID || undefined,
    zoneId: env.CF_EMAIL_ROUTING_ZONE_ID || undefined,
    zoneName: env.CF_EMAIL_ROUTING_ZONE_NAME || "developershub.jp",
    workerName: env.CF_EMAIL_ROUTING_WORKER || "dub-mail-gateway",
    timeoutMs: parseTimeoutMs(env),
    fetchImpl: undefined,
  };
}

/** True when the token secret is present (feature wired). Non-secret. */
export function emailRoutingConfigured(env: Env): boolean {
  return typeof env.CF_EMAIL_ROUTING_TOKEN === "string" && env.CF_EMAIL_ROUTING_TOKEN.length > 0;
}

/** Non-secret readiness snapshot for /internal/health/ready. Never echoes the token. */
export function emailRoutingReadiness(env: Env): {
  configured: boolean;
  zoneConfigured: boolean;
  accountConfigured: boolean;
  zoneName: string;
} {
  return {
    configured: emailRoutingConfigured(env),
    zoneConfigured: !!(env.CF_EMAIL_ROUTING_ZONE_ID && env.CF_EMAIL_ROUTING_ZONE_ID.length > 0),
    accountConfigured: !!(env.CF_EMAIL_ROUTING_ACCOUNT_ID && env.CF_EMAIL_ROUTING_ACCOUNT_ID.length > 0),
    zoneName: env.CF_EMAIL_ROUTING_ZONE_NAME || "developershub.jp",
  };
}

/** Throw a 503 when the token is unset — the single "not configured" signal callers use. */
export function requireEmailRoutingConfig(env: Env): EmailRoutingConfig {
  const cfg = emailRoutingConfigFromEnv(env);
  if (!cfg) {
    throw new DubError(
      "MAIL_EMAIL_ROUTING_UNCONFIGURED",
      "Cloudflare Email Routing admin is not configured: set the CF_EMAIL_ROUTING_TOKEN Worker secret",
      { status: 503, retryable: false },
    );
  }
  return cfg;
}

/** Extract a token-free, human-readable detail from a Cloudflare error envelope / body. */
function cfErrorDetail(status: number, parsed: CfEnvelope<unknown> | null, fallback: string): string {
  const msgs = parsed?.errors?.map((e) => e.message).filter((m): m is string => typeof m === "string" && m.length > 0) ?? [];
  const detail = msgs.length > 0 ? msgs.join("; ") : fallback;
  return `Cloudflare Email Routing API error (${status}): ${detail}`;
}

export class CfEmailRoutingClient {
  constructor(private readonly cfg: EmailRoutingConfig) {}

  private requireAccount(): string {
    if (!this.cfg.accountId) {
      throw new DubError(
        "MAIL_EMAIL_ROUTING_UNCONFIGURED",
        "Cloudflare account id is not configured: set CF_EMAIL_ROUTING_ACCOUNT_ID (destination addresses are account-scoped)",
        { status: 503, retryable: false },
      );
    }
    return this.cfg.accountId;
  }

  private requireZone(): string {
    if (!this.cfg.zoneId) {
      throw new DubError(
        "MAIL_EMAIL_ROUTING_UNCONFIGURED",
        "Cloudflare zone id is not configured: set CF_EMAIL_ROUTING_ZONE_ID (routing rules are zone-scoped)",
        { status: 503, retryable: false },
      );
    }
    return this.cfg.zoneId;
  }

  /** One Cloudflare API call. Returns the whole envelope so list callers can read result_info. */
  private async call<T>(method: string, path: string, body?: unknown): Promise<CfEnvelope<T>> {
    const doFetch = this.cfg.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${CF_API_BASE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.cfg.token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS),
      });
    } catch (err) {
      // Network reset / DNS / abort(timeout): treat as a retryable upstream outage.
      throw new DubError("MAIL_EMAIL_ROUTING_UPSTREAM", "Cloudflare Email Routing request failed", {
        status: 502,
        cause: err,
        retryable: true,
      });
    }

    const parsed = (await res.json().catch(() => null)) as CfEnvelope<T> | null;
    if (!res.ok || !parsed || parsed.success !== true) {
      throw new DubError("MAIL_EMAIL_ROUTING_UPSTREAM", cfErrorDetail(res.status, parsed, res.statusText || "request rejected"), {
        status: 502,
        retryable: res.status >= 500 || res.status === 429,
      });
    }
    return parsed;
  }

  // ---- destination addresses (account-scoped) ----
  async listAddresses(): Promise<CfDestinationAddress[]> {
    const account = this.requireAccount();
    const env = await this.call<CfDestinationAddress[]>("GET", `/accounts/${account}/email/routing/addresses?per_page=50`);
    return env.result ?? [];
  }

  async createAddress(email: string): Promise<CfDestinationAddress> {
    const account = this.requireAccount();
    const env = await this.call<CfDestinationAddress>("POST", `/accounts/${account}/email/routing/addresses`, { email });
    return env.result;
  }

  async deleteAddress(id: string): Promise<CfDestinationAddress> {
    const account = this.requireAccount();
    const env = await this.call<CfDestinationAddress>("DELETE", `/accounts/${account}/email/routing/addresses/${encodeURIComponent(id)}`);
    return env.result;
  }

  // ---- routing rules (zone-scoped) ----
  async listRules(): Promise<CfRoutingRule[]> {
    const zone = this.requireZone();
    const env = await this.call<CfRoutingRule[]>("GET", `/zones/${zone}/email/routing/rules?per_page=50`);
    return env.result ?? [];
  }

  async createRule(input: CreateRuleInput): Promise<CfRoutingRule> {
    const zone = this.requireZone();
    const env = await this.call<CfRoutingRule>("POST", `/zones/${zone}/email/routing/rules`, input);
    return env.result;
  }

  async updateRule(id: string, patch: UpdateRuleInput): Promise<CfRoutingRule> {
    const zone = this.requireZone();
    const env = await this.call<CfRoutingRule>("PATCH", `/zones/${zone}/email/routing/rules/${encodeURIComponent(id)}`, patch);
    return env.result;
  }

  async deleteRule(id: string): Promise<CfRoutingRule> {
    const zone = this.requireZone();
    const env = await this.call<CfRoutingRule>("DELETE", `/zones/${zone}/email/routing/rules/${encodeURIComponent(id)}`);
    return env.result;
  }
}
