// commander-relay Worker bindings. Everything is optional so tests and the health probe run
// on a partial set; each missing piece fails CLOSED (503) instead of opening the relay.
import type { DurableObjectNamespace, Fetcher } from "@cloudflare/workers-types";

export interface Env {
  /** The single CommanderRelay DO (one instance, name "owner") that pairs agent and browsers. */
  RELAY?: DurableObjectNamespace;
  /** identity-roster: backs the policy gate's permission check on the ticket/status routes. */
  SVC_IDENTITY?: Fetcher;

  /** HMAC key for the 60s browser ws-ticket (wrangler secret). */
  RELAY_TICKET_SECRET?: string;
  /** Shared secret the LOCAL agent presents as `Authorization: Bearer` (wrangler secret). */
  RELAY_AGENT_SECRET?: string;
  /** Public wss URL of this Worker's browser endpoint, returned with each ticket. */
  RELAY_WS_URL?: string;
  /** Comma-separated exact browser origins allowed to open the browser socket. */
  RELAY_ALLOWED_ORIGINS?: string;
  /**
   * Optional comma-separated user ids. When set, only these users get a ticket even if their
   * role holds app:commander:edit — the relay drives the operator's own PC, so this narrows
   * "any admin" down to the machine's owner.
   */
  COMMANDER_OWNER_USER_IDS?: string;

  ENVIRONMENT?: string;
}
