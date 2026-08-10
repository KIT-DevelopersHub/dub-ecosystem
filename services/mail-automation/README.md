# mail-automation-service

Inbound-mail **decision logic** for the DevHub (Dub) ecosystem. It decides *how to
react* to a received email (rule eval → template render → loop prevention) and
delegates all actual send/receive to **mail-gateway**. It stores no mail bodies.

- **kind**: Cloudflare Worker (Hono) + Queue consumer
- **namespace**: `mailauto_*` (D1, single shared `dub-core` DB)
- **entrypoint**: `src/index.ts` (`fetch` = internal API, `queue` = inbound pipeline)

## Pipeline (ordered guards)

`processInbound` (src/pipeline.ts) runs, in order:

1. global kill switch (`automation_enabled`, default **false**)
2. business idempotency (`gateway_message_id` unique; `force` bypasses)
3. loop headers — `Auto-Submitted` ≠ no / `Precedence: bulk|list|junk` / `List-Id`
4. self-sender (our own auto-send domain/address)
5. thread round-trip depth (`maxRepliesPerThread`, default 2)
6. per-recipient daily rate (rule cap vs global default, smaller wins; 0 = off) — reply path
7. rule evaluation (priority asc, first match, AND conditions)

Reply sends stamp `idempotencyKey = "mailauto:"+decisionId`, the receiving
`mailbox`, and `Auto-Submitted: auto-replied`. Every finalized decision persists to
`mailauto_decisions`, emits `mail.automation.decided` (+ `mail.automation.routed` on
route), and writes one `publishAudit` summary (`mail.automation.decide`, no body).

## Internal HTTP API

All routes require `x-dub-internal` (else 404), trusted-header auth, and a
`mail:read` / `mail:admin` permission. See `src/app.ts`:
`/rules` `/rules/:id` `/templates` `/templates/:id` `/process` `/dry-run`
`/decisions` `/settings`.

## Contract posture (P0b)

- **Foundation packages used as-is** (`@dub/types|db|events|auth-client|errors|http|observability`); not re-implemented.
- The frozen `@dub/types` `mailAutomation`/`mail` namespaces and the `@dub/events`
  payload map are **thinner** than the P0a design draft's proposed rich types
  (those additions never landed). The richer domain model (rules/templates/
  decisions) therefore lives **service-local** in `src/types.ts`; emitted wire
  payloads conform to the frozen thin `@dub/events` shapes.
- **mail-gateway is a STUB** (interface in `src/gateway.ts`); real wiring waits on
  9-B. Queue creation waits on 9-B too — `wrangler.toml` is a template
  (**deploy disabled**). Unit tests inject fakes.

## Test / typecheck

```
pnpm --filter ./services/mail-automation test       # 51 tests
pnpm --filter ./services/mail-automation typecheck
```
