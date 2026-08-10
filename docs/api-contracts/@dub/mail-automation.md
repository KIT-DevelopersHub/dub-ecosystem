# API Contract — @dub/mail-automation

Status: Component contract (v1). Read [`_conventions.md`](../_conventions.md) first for the
shared envelope, headers, error wire form, pagination, IDs, and versioning; and
[`auth.md`](../auth.md) for authn/authz. This doc only adds what is
**mail-automation-specific**: the surface topology (internal-only HTTP + queue consumer),
the rule / template / decision resource shapes, the ordered decision pipeline, the eight
CRUD/operation endpoints, the loop-guard semantics, and the events + audit it emits.

`@dub/mail-automation` is the inbound-mail **decision engine** for the DevHub (Dub)
ecosystem. On each received email it decides *how to react* — evaluate rules → render a
template → run loop/rate guards → optionally send one reply — and delegates all actual
send/receive to **mail-gateway**. It stores **no mail bodies** (only decisions + counters).

**Source of truth (code).** If code and this doc disagree, the code wins and this doc must
be corrected.

| Concern | Code |
|---|---|
| Internal HTTP routes + guards | `services/mail-automation/src/app.ts` |
| Service-local domain model (rules/templates/decisions/DTOs) | `services/mail-automation/src/types.ts` |
| Decision pipeline (ordered guards) + dry-run | `services/mail-automation/src/pipeline.ts` |
| Rule evaluation + write-time validation | `services/mail-automation/src/rules.ts` |
| Template render (`{{var}}`) | `services/mail-automation/src/templates.ts` |
| Loop-prevention guards (headers + self-sender) | `services/mail-automation/src/loop-guard.ts` |
| Service-specific error codes | `services/mail-automation/src/errors.ts` |
| Worker entry: `fetch` (API) + `queue` (consumer), bindings | `services/mail-automation/src/index.ts` |
| mail-gateway dependency (send / getMessage) | `services/mail-automation/src/gateway.ts` |
| Emitted event payloads / catalog / subscriptions | `packages/events/src/{payloads,catalog}.ts` |
| Frozen wire anchors (`mail`, `common`, `auditLog`) | `packages/types/src/{mail,common,audit-log}.ts` |

- `CONTRACT_VERSION`: `1.0.0` (P0b freeze)
- Service package: `@dub/mail-automation` (Cloudflare Worker + Hono + Queue consumer)

---

## 1. Surface topology

mail-automation is an **internal service with no public hostname**. It is **not** mounted by
api-gateway; the web/mobile clients never reach it directly. It has exactly two surfaces:

| Surface | Reachable via | Auth gate | Callers |
|---|---|---|---|
| Internal HTTP API | Service Binding only | `x-dub-internal` present **and** `x-dub-user-id` (trusted) **and** a `mail:read` / `mail:admin` permission | admin/BFF surfaces that manage rules/templates & operators triggering dry-runs |
| Queue consumer | Queue `dub-q-evt-mail-automation` | event envelope (system actor) | the platform, delivering `mail.message.received` |

Every HTTP route runs three guards in order (`src/app.ts`):

1. **`internalOnly`** — the request must carry `x-dub-internal`. If absent the route returns
   **`404 NOT_FOUND`** (route-hiding parity with mail-gateway: a non-internal caller cannot
   even learn the path exists). This is checked *before* auth.
2. **`requireAuth()`** — a trusted `x-dub-user-id` must be present (`trustedHeader` mode; no
   token re-verification). Absent → **`401 AUTH_INVALID_TOKEN`**.
3. **`requirePermission(...)`** — `mail:read` for reads/dry-run, `mail:admin` for every
   mutation and for `POST /process`. Denied → **`403 FORBIDDEN`**.

This service is a **downstream** service: it runs `dubContext({ allowGenerate: false })`, so
it does **not** mint request ids — the caller must forward `x-dub-request-id`.

### 1.1 Request context headers

| Header | Meaning | Who sets it |
|---|---|---|
| `x-dub-request-id` | Correlation id; echoed into `ErrorResponse.error.requestId` and every audit record. **Required** (not generated here). | calling service |
| `x-dub-user-id` | Trusted subject id; the actor for permission checks, `createdBy`, audit `actorId`. | calling service (already verified upstream) |
| `x-dub-internal` | Presence-only marker `"1"`. Required by **every** route. | calling service (Service Binding) |

### 1.2 Auth / authz failures

| Condition | Code | HTTP |
|---|---|---|
| Any route without `x-dub-internal` | `NOT_FOUND` | 404 |
| Route with `x-dub-internal` but no `x-dub-user-id` | `AUTH_INVALID_TOKEN` | 401 |
| Authenticated user lacks the route's permission | `FORBIDDEN` | 403 |

---

## 2. Error wire form

Every error is the standard `@dub/errors` `ErrorResponse` (see `_conventions.md`), emitted by
`dubErrorHandler({ service: "mail-automation" })`:

```json
{
  "error": {
    "code": "MAILAUTO_RULE_NOT_FOUND",
    "message": "Rule not found: rule_01J...",
    "details": null,
    "requestId": "req_01J...",
    "service": "mail-automation",
    "retryable": false
  }
}
```

Common codes reused: `VALIDATION_FAILED` (400), `AUTH_INVALID_TOKEN` (401), `FORBIDDEN`
(403), `NOT_FOUND` (404). Service-specific codes (`src/errors.ts`), all carrying `service:
"mail-automation"`:

| Code | HTTP | Meaning |
|---|---|---|
| `MAILAUTO_INVALID_RULE` | 400 | Empty conditions, un-compilable regex, or an action missing its required field (`templateId` / `assigneeUserId` / `label`). |
| `MAILAUTO_TEMPLATE_VAR_MISSING` | 400 | Render referenced a `{{var}}` (or declared variable) absent from the render context. `details.missing` lists them. Runtime-only (during `/process` / `/dry-run`); surfaces as a `suppressReasons` entry rather than a thrown HTTP error inside the pipeline. |
| `MAILAUTO_RULE_NOT_FOUND` | 404 | Unknown rule id. |
| `MAILAUTO_TEMPLATE_NOT_FOUND` | 404 | Unknown template id (on template PATCH). |
| `MAILAUTO_DUPLICATE_MESSAGE` | 409 | Reserved for hard-duplicate rejection (the pipeline default is a soft `suppressed_duplicate` outcome, §5). |
| `MAILAUTO_RULE_REFERENCES_MISSING_TEMPLATE` | 422 | A `reply` rule create/patch references a `templateId` that does not exist. |

---

## 3. Resource shapes

These live **service-local** in `src/types.ts` (the frozen `@dub/types` `mailAutomation`
namespace is intentionally thinner; the rich model was not re-opened into foundation). Wire
payloads emitted onto queues still conform to the frozen `@dub/events` shapes (§7).

### 3.1 `AutomationRule`

```json
{
  "id": "rule_01J...",
  "name": "Auto-ack conference CFP replies",
  "enabled": true,
  "priority": 100,
  "conditions": [
    { "field": "to", "op": "domain_is", "value": "developershub.jp" },
    { "field": "subject", "op": "contains", "value": "CFP" }
  ],
  "action": { "type": "reply", "templateId": "tpl_01J..." },
  "eventId": "evt_01J...",
  "rateLimitPerRecipientPerDay": 3,
  "createdBy": "user_01J...",
  "createdAt": "2026-08-10T00:00:00Z",
  "updatedAt": "2026-08-10T00:00:00Z"
}
```

- `enabled` defaults `false` (opt-in). Only enabled rules participate in evaluation.
- `priority` — lower runs first; **first match wins**; ties broken by `createdAt` ascending.
- `conditions` — ANDed. **Empty conditions never match** (fail-safe). Fields / ops:

  | `field` | Resolves to (any-match) | `op` values |
  |---|---|---|
  | `from` | sender email | `equals`, `contains`, `regex`, `domain_is` |
  | `to` | each recipient email | (same) |
  | `subject` | subject | (same) |
  | `body` | the gateway **snippet** (no full body is held here) | (same) |
  | `listId` | header `list-id` | (same) |
  | `eventTag` | header `x-dub-event-tag` | (same) |

  `contains` is case-insensitive; `domain_is` compares the address domain (lower-cased);
  `regex` is a JS `RegExp` over the field value (an un-compilable pattern → `MAILAUTO_INVALID_RULE`).

- `action` is a discriminated union:

  | `type` | Extra fields | Decision outcome when matched |
  |---|---|---|
  | `reply` | `templateId` | `replied` (after rate + render + send) |
  | `route` | `assigneeUserId`, `note?` | `routed` |
  | `label` | `label` | `labeled` |
  | `ignore` | — | `ignored_no_match` |

- `eventId` — optional link to an event; when set, `event_id` (and, if event-service is
  bound, `event_name`) are injected into the template render context.
- `rateLimitPerRecipientPerDay` — per-sender daily cap on the **reply** path. `0` disables
  the rule's own cap; otherwise the **smaller** of this and the global default applies.

### 3.2 `MailTemplate`

```json
{
  "id": "tpl_01J...",
  "name": "cfp-ack",
  "subject": "Re: {{subject}}",
  "body": "Hi {{sender_name}}, thanks for your CFP submission to {{event_name}}.",
  "variables": ["sender_name", "subject", "event_name"],
  "createdAt": "2026-08-10T00:00:00Z",
  "updatedAt": "2026-08-10T00:00:00Z"
}
```

`{{var}}` tokens are substituted at render. Any token referenced in `subject`/`body` **or**
listed in `variables` that is missing from the render context makes the render fail
(`MAILAUTO_TEMPLATE_VAR_MISSING`) and the reply is **not** sent. Context keys the pipeline
always provides: `sender_name`, `sender_email`, `subject`; plus `event_id` / `event_name`
when the matched rule has an `eventId`.

### 3.3 `DecisionRecord`

```json
{
  "id": "mailauto_dec_01J...",
  "gatewayMessageId": "msg_01J...",
  "threadId": "thr_01J...",
  "fromAddr": "sender@example.com",
  "outcome": "replied",
  "matchedRuleId": "rule_01J...",
  "sentMessageId": "sent_01J...",
  "suppressReasons": [],
  "decidedAt": "2026-08-10T00:00:00Z"
}
```

`outcome` is one of: `replied`, `routed`, `labeled`, `ignored_no_match`, `suppressed_loop`,
`suppressed_rate`, `suppressed_disabled`, `suppressed_duplicate`, `error`.

### 3.4 `AutomationSettings`

```json
{ "automationEnabled": false, "maxRepliesPerThread": 2, "defaultRatePerRecipientPerDay": 5 }
```

`automationEnabled` is the **global kill switch** (initial `false` — nothing auto-replies
until an admin flips it).

---

## 4. Endpoints

All paths are **internal** (Service-Binding form; no `/api/v1` prefix). Every route requires
`x-dub-internal` + `x-dub-user-id`. The **Perm** column is the permission the actor must hold.

| Method + Path | Perm | Purpose |
|---|---|---|
| `GET /rules` | `mail:read` | List rules |
| `POST /rules` | `mail:admin` | Create rule |
| `GET /rules/:id` | `mail:read` | Get one rule |
| `PATCH /rules/:id` | `mail:admin` | Update rule |
| `DELETE /rules/:id` | `mail:admin` | Soft-delete rule |
| `GET /templates` | `mail:read` | List templates |
| `POST /templates` | `mail:admin` | Create template |
| `PATCH /templates/:id` | `mail:admin` | Update template |
| `POST /process` | `mail:admin` | Run the full pipeline on one message (persist + send + emit) |
| `POST /dry-run` | `mail:read` | Evaluate one message with **no** persistence / send / emit |
| `GET /decisions` | `mail:read` | List decision records (audit trail) |
| `GET /settings` | `mail:read` | Read automation settings |
| `PATCH /settings` | `mail:admin` | Update settings (kill switch, caps) |

Lists return a `_conventions.md` collection envelope: `{ "items": [...], "nextCursor": null }`
(P0 returns all rows in one page; `nextCursor` is always `null`).

### 4.1 `GET /rules`

Query (both optional): `enabled` (`true`/`false`), `eventId`.

Response `200`:

```json
{ "items": [ /* AutomationRule[] */ ], "nextCursor": null }
```

### 4.2 `POST /rules`

Request — `CreateRuleInput`:

```json
{
  "name": "Auto-ack conference CFP replies",
  "enabled": true,
  "priority": 100,
  "conditions": [{ "field": "subject", "op": "contains", "value": "CFP" }],
  "action": { "type": "reply", "templateId": "tpl_01J..." },
  "eventId": "evt_01J...",
  "rateLimitPerRecipientPerDay": 3
}
```

`enabled` (default `false`), `priority` (default assigned server-side), `eventId`,
`rateLimitPerRecipientPerDay` are optional. The shape is validated (`validateRuleShape`):
non-empty conditions, compilable regex, action-specific required field. A `reply` action's
`templateId` must resolve to an existing template.

Response `201` — the created `AutomationRule`. Errors: invalid shape →
`400 MAILAUTO_INVALID_RULE`; malformed JSON → `400 VALIDATION_FAILED`
(`{ field: "body", reason: "invalid_json" }`); reply template missing →
`422 MAILAUTO_RULE_REFERENCES_MISSING_TEMPLATE`.

### 4.3 `GET /rules/:id`

Response `200` — the `AutomationRule`. Unknown id → `404 MAILAUTO_RULE_NOT_FOUND`.

### 4.4 `PATCH /rules/:id`

Request — `UpdateRuleInput` (partial `AutomationRule` minus `id`/`createdBy`/timestamps). If
both `conditions` and `action` are present they are re-validated; if the (new) action is
`reply`, its `templateId` must exist.

```json
{ "enabled": false, "priority": 50 }
```

Response `200` — the updated rule. Unknown id → `404 MAILAUTO_RULE_NOT_FOUND`; reply template
missing → `422 MAILAUTO_RULE_REFERENCES_MISSING_TEMPLATE`.

### 4.5 `DELETE /rules/:id`

Soft-delete. Response `204` (no body). Unknown id → `404 MAILAUTO_RULE_NOT_FOUND`.

### 4.6 `GET /templates`

Response `200` — `{ "items": [ /* MailTemplate[] */ ], "nextCursor": null }`.

### 4.7 `POST /templates`

Request — `CreateTemplateInput`:

```json
{ "name": "cfp-ack", "subject": "Re: {{subject}}", "body": "Hi {{sender_name}}, thanks!", "variables": ["sender_name", "subject"] }
```

`name`, `subject`, `body` are all required; missing any →
`400 VALIDATION_FAILED` (`{ field: "template", reason: "name_subject_body_required" }`).
`variables` is optional.

Response `201` — the created `MailTemplate`.

### 4.8 `PATCH /templates/:id`

Request — `UpdateTemplateInput` (partial `MailTemplate` minus `id`/timestamps).

```json
{ "subject": "Re: [DevHub] {{subject}}" }
```

Response `200` — the updated template. Unknown id → `404 MAILAUTO_TEMPLATE_NOT_FOUND`.

### 4.9 `POST /process`

Run the full pipeline (§5) on one inbound message: persist the decision, emit events, write
the audit summary, and perform at most one mail-gateway send. This mirrors what the queue
consumer does; the endpoint exists for operator-triggered reprocessing.

Request — `ProcessRequest`:

```json
{
  "mail": {
    "id": "msg_01J...",
    "messageId": "<abc@mail.example.com>",
    "threadId": "thr_01J...",
    "from": { "email": "sender@example.com", "name": "Alex" },
    "to": [{ "email": "cfp@developershub.jp" }],
    "subject": "CFP: my talk",
    "snippet": "Here is my proposal...",
    "receivedAt": "2026-08-10T00:00:00Z",
    "mailbox": "cfp",
    "headers": { "list-id": "", "auto-submitted": "no" },
    "references": ["<root@mail.example.com>"]
  },
  "force": false
}
```

`mail` is the reconciled `InboundMail` = frozen `mail.MailMessage` + optional enrichment
(`mailbox`, lower-cased `headers`, `references`) mirrored from mail-gateway's `InboundMailView`.
`mail.id` is required (missing → `400 VALIDATION_FAILED`, `{ field: "mail.id", reason:
"required" }`). `force: true` bypasses the business-idempotency (duplicate) guard.

Response `200` — `ProcessResponse`:

```json
{ "decisionId": "mailauto_dec_01J...", "outcome": "replied", "matchedRuleId": "rule_01J...", "sentMessageId": "sent_01J..." }
```

`matchedRuleId` / `sentMessageId` are `null` when not applicable (e.g. a suppressed or
no-match outcome). A re-processed duplicate (without `force`) returns the **existing**
decision id with `outcome: "suppressed_duplicate"`.

### 4.10 `POST /dry-run`

Evaluate a message **without** persistence, event emission, audit, or send — the safe
preview an operator uses to test rules/templates.

Request — `DryRunRequest`: `{ "mail": InboundMail }` (same `InboundMail` as §4.9; `mail.id`
required).

Response `200` — `DryRunResponse`:

```json
{
  "wouldMatch": { /* AutomationRule or null */ },
  "wouldOutcome": "replied",
  "renderedReply": { "subject": "Re: CFP: my talk", "body": "Hi Alex, thanks!" },
  "suppressReasons": []
}
```

`renderedReply` is `null` unless the would-be outcome is a reply that rendered cleanly.
`suppressReasons` explains any suppression (e.g. `["automation_disabled"]`,
`["thread_max_replies"]`, `["rate_limited"]`).

### 4.11 `GET /decisions`

Query (all optional): `messageId`, `ruleId`, `outcome` (a `DecisionOutcome`), `limit`.

Response `200` — `{ "items": [ /* DecisionRecord[] */ ], "nextCursor": null }`.

### 4.12 `GET /settings` · `PATCH /settings`

`GET` → `200` `AutomationSettings`. `PATCH` accepts a partial `AutomationSettings` (e.g.
`{ "automationEnabled": true }`) and returns the updated `200` `AutomationSettings`. Flipping
`automationEnabled` is the global kill-switch control.

---

## 5. Decision pipeline (ordered guards)

`processInbound` (`src/pipeline.ts`) applies guards **in order**; the first that fires
determines the outcome. `/process`, `/dry-run` (send disabled), and the queue consumer all
run this sequence.

| # | Guard | Fires → outcome | `suppressReasons` |
|---|---|---|---|
| 1 | Global kill switch (`automationEnabled` false) | `suppressed_disabled` | `automation_disabled` |
| 2 | Business idempotency — `gatewayMessageId` already decided (skipped if `force`) | `suppressed_duplicate` (returns existing decision) | — |
| 3 | Loop headers — `Auto-Submitted` ≠ `no` / `Precedence: bulk\|list\|junk` / `List-Id` present | `suppressed_loop` | `auto_submitted` / `precedence_bulk` / `list_id_present` |
| 4 | Self-sender — `from` is one of our own auto-send addresses/domains | `suppressed_loop` | `self_address` / `self_domain` |
| 5 | Thread round-trip depth ≥ `maxRepliesPerThread` | `suppressed_loop` | `thread_max_replies` |
| 6 | Rule evaluation (enabled, priority asc, first AND-match) | no match → `ignored_no_match`; else the matched action's outcome | — |
| 7 | *(reply only)* Per-recipient daily rate — used ≥ `min(ruleCap, defaultCap)` (`0` = off) | `suppressed_rate` | `rate_limited` |
| 8 | *(reply only)* Template load + render — missing template / unresolved var / bad render | `error` | `missing_template` / `MAILAUTO_TEMPLATE_VAR_MISSING` / `template_render_failed` |
| 9 | *(reply only)* Send via mail-gateway | success → `replied`; gateway throw → `error` | (gateway error code) / `gateway_error` |

Reply sends stamp `idempotencyKey = "mailauto:" + decisionId`, the receiving `mailbox`, and
loop headers `Auto-Submitted: auto-replied` + `x-dub-mail-loop: <decisionId>`. On success the
per-recipient and per-thread counters are incremented. **Every** finalized decision (including
suppressed/error) is persisted to the decision store, emits `mail.automation.decided`
(+ `mail.automation.routed` on a route), and writes exactly one `mail.automation.decide`
audit summary (**no body/subject**).

---

## 6. Queue consumer

Binding: consumes `dub-q-evt-mail-automation`; subscribes to **`mail.message.received`** (per
the frozen `@dub/events` SUBSCRIPTIONS map). The envelope payload is thin:

```json
{ "messageId": "msg_01J...", "threadId": "thr_01J..." }
```

The consumer (`src/index.ts`) fetches the full message from mail-gateway
(`getMessage(messageId)`), then runs `processInbound` with `{ actorId: event.actorId }`.
Cross-batch idempotency is enforced via an `IdempotencyStore` keyed on the event id (a
redelivered event is a no-op). Batch config (`wrangler.toml`): `max_batch_size 25`,
`max_retries 5`, DLQ `dub-q-evt-mail-automation-dlq`.

> **P0 deploy posture.** mail-gateway is a **stub** (`src/gateway.ts` interface); real wiring
> and queue creation wait on integration wave 9-B, so `wrangler.toml` is a template with
> **deploy disabled**. Unit tests inject fakes. The wire contract above is frozen regardless.

---

## 7. Events & audit emitted

Emitted onto queues via `@dub/events` `publishEvent` (routed to subscribers per the frozen
SUBSCRIPTIONS table — both events go to **notification**). Payloads conform to the frozen thin
`@dub/events` shapes:

| Event | When | Payload | Subscribers |
|---|---|---|---|
| `mail.automation.decided` | every finalized decision (all outcomes) | `{ "ruleId": string \| null, "decision": string }` | notification |
| `mail.automation.routed` | additionally, when the outcome is `routed` | `{ "messageId": string }` | notification |

Audit: one `mail.automation.decide` record per decision via `publishAudit` (the Queue audit
channel), using `auditLog.AuditRecordInput`:

```json
{
  "action": "mail.automation.decide",
  "actorId": "user_01J...",
  "orgId": "org_devhub",
  "result": "success",
  "resourceType": "mail_message",
  "resourceId": "msg_01J...",
  "details": { "outcome": "replied", "matchedRuleId": "rule_01J...", "suppressReasons": [] },
  "requestId": "req_01J...",
  "occurredAt": "2026-08-10T00:00:00Z"
}
```

`result` is `failure` only when `outcome === "error"`, else `success`. For a `route` outcome
`details.assigneeUserId` is included. The audit record never contains the mail body or subject.

---

## 8. Notes for consumers

- **Do not call mail-automation from the web.** It is Service-Binding-internal; the gateway
  neither routes to it nor exposes its paths. A missing `x-dub-internal` yields `404`, not `403`.
- **Rules are opt-in and off by default**, and the whole engine is gated by the
  `automationEnabled` kill switch — a freshly provisioned deployment auto-replies to nothing.
- **`/dry-run` is the safe path** for tuning rules/templates: it never persists, sends, or
  emits. Use `/process` only to (re)drive a real decision.
- **Idempotency is layered**: queue-level (event id) + business-level (`gatewayMessageId`) +
  send-level (`idempotencyKey` to mail-gateway). Reprocessing a message is safe.
- Pagination, ID formats, timestamp format, and the error envelope are governed by
  [`_conventions.md`](../_conventions.md); authn/authz by [`auth.md`](../auth.md).
