// THE authorization surface of webhook-ingest. Every endpoint this Worker serves is listed
// here with what its caller must carry; `policyGate` (mounted first in app.ts) enforces it and
// NOTHING else in this service checks authorization. A route added to app.ts without a line
// here is denied at runtime and turns test/policy-table.test.ts red.
//
// THIS SERVICE HAS TWO FACES, and the table is the only place that says so plainly:
//
//   1. PROVIDER INGRESS (`/hooks/:source`) — reached DIRECTLY on this Worker's own hostname
//      (wrangler.toml `routes` = hooks.developershub.jp), never through api-gateway. GitHub,
//      Google, Stripe and Pub/Sub have no Dub session and never will, so these are `PUBLIC`
//      by necessity, not by omission. What authenticates them is a per-source CRYPTOGRAPHIC
//      check of the raw body (HMAC / timing-safe token / OIDC JWT) that stays in the handler —
//      see the note on the two entries below.
//   2. ADMINISTRATIVE READS (`/webhooks/deliveries*`) — reached through api-gateway's
//      `webhooks` segment by a signed-in operator, so they are ordinary key-gated routes.
//
// WHY THERE IS NO `appLevel(...)` HERE: APP_MANIFEST has no "webhooks" app (there is no
// launcher tile for delivery search), so `app:webhooks:view/edit` do not exist and
// `appLevel("webhooks", ...)` would throw at module load. The inventory records this as
// §3(c) and prescribes the plain domain key, which is what the two reads use. Do NOT invent
// the app or the keys to make the call sites look uniform.
import { definePolicyTable, INTERNAL, PUBLIC } from "@dub/policy-gate";

export const POLICY_TABLE = definePolicyTable({
  // ---- liveness ----
  // INTERNAL, deliberately not PUBLIC. Its only caller is app-health-monitor (src/config.ts
  // target "webhook-ingest", path "/internal/health"), which probes over the SVC_WEBHOOK
  // Service Binding through `probeBinding` — that helper sets `x-dub-internal: "1"` on every
  // probe, so INTERNAL costs the real caller nothing.
  //
  // HONEST CAVEAT, recorded rather than hidden: this Worker is meant to publish its OWN
  // hostname for the provider ingress (hooks.developershub.jp — currently commented out in
  // wrangler.toml, so reachability is infra-config dependent). On that hostname requests do
  // NOT pass api-gateway's x-dub-* stripping, so `x-dub-internal` is forgeable there, exactly
  // as inventory a-7 describes for app-health-monitor. INTERNAL is therefore not an absolute
  // barrier here — but it is strictly stronger than PUBLIC (it stops every caller who does
  // not know to send the header, and it states the intent), and the body is a two-field
  // liveness object. The real fix for the forgeability is a host guard on the public
  // hostname, which is out of this migration's scope.
  "GET /internal/health": INTERNAL,

  // ---- provider ingress: PUBLIC by necessity, authenticated by signature ----
  // `PUBLIC` here means what rule.ts says it means — "the open internet may call this, and
  // that is INTENDED". An external provider is the only caller there can be.
  //
  // The handler's verification is NOT the double-authz that this migration removes: it is
  // AUTHENTICATION of a request that carries no session, over the raw body bytes, and it is
  // per-source (github HMAC-SHA256, stripe HMAC + replay window, google-drive timing-safe
  // channel token, gmail Pub/Sub OIDC JWT with a pinned service-account identity). It
  // consults no permission key, so gate.ts's "no other layer performs an authorization
  // check" rule does not reach it. A missing secret fails CLOSED (401). Do not remove it, and
  // do not try to express it as a rule — see inventory §3(d): a static table cannot verify a
  // signature over request data.
  "POST /hooks/:source": PUBLIC,

  // Endpoint-reachability handshake (Google Drive's channel watch verifies the callback URL
  // answers). Must be callable by a provider that holds nothing, so PUBLIC is the only
  // possible rule. Inventory a-8 notes the disclosure: the response reveals which of the four
  // sources are ENABLED. Accepted, and it is small — the body is `{status, source}` with no
  // delivery data, every known source is enabled today, and the ingress endpoint's existence
  // already implies as much. Keep it that way: if this handler ever starts returning anything
  // about deliveries or configuration, it stops being a handshake and needs a key.
  "GET /hooks/:source": PUBLIC,

  // ---- administrative delivery reads (via api-gateway; signed-in operator) ----
  // `webhook:read` only — the previous guard was `requireAuth` + `requirePermission("webhook:read")`
  // with NO resource scope (the `resolve` argument was never passed), so there is no
  // instance-level check to carry over into the handlers (gate.ts's two-layer rule / inventory
  // b-5 do not apply here). The repo query is org-wide by construction.
  //
  // PATH NOTE (inventory a-6, fixed in the same commit as this file): these were registered at
  // `/api/v1/webhooks/deliveries`, but api-gateway strips API_PREFIX before forwarding, so the
  // only path that ever arrives is `/webhooks/deliveries`. Both routes were therefore DEAD
  // (404 at the receiver) and the table would have frozen a surface nobody could reach. The
  // keys below are the rule for the live path; `packages/types` WEBHOOK_WIRE already names it.
  "GET /webhooks/deliveries": ["webhook:read"],
  "GET /webhooks/deliveries/:id": ["webhook:read"],
});
