# Wire-contract enforcement (query params & shapes cannot drift between client and server)

Status: Mechanism v1. Proven on gantt; rollout guidance below.

## Conclusion (what to do)

Keep **`@dub/types` + `docs/openapi/*.yaml` as the single source of truth (SoT)**, and
**let CI reconcile every side against it** — client, server, and spec. A contract is not
"agreed" because each side has a test; it is agreed only when one shared SoT is enforced
across the boundary. Concretely, for every endpoint:

1. The query-parameter **names** and the request/response **shapes** live once, in
   `@dub/types` (types) and the endpoint's OpenAPI spec (wire).
2. The client builds its request **from** those types (never hand-renames a key).
3. A conformance test fails CI (red = unmergeable) if the client keys, the server reads,
   and the spec params ever disagree.

## Reason (why the gantt "Validation failed" happened)

The pieces were all individually "correct" and individually tested, yet prod broke:

| Side | What it used | Test that guarded it |
|---|---|---|
| `@dub/types` `GetGanttQuery` | `eventId` | (type only, not enforced at the wire) |
| gantt-service | `c.req.query("eventId")` | server tests, green |
| OpenAPI spec | `?eventId=` | route conformance (path/method only) |
| **fe4 client** | **`?event=`** | fe unit tests, green — **against a mock that shared the same wrong key** |

Two failures compounded: (a) the client hand-mapped the query key instead of deriving it
from the SoT type, and (b) the only cross-side check (`packages/e2e-smoke` conformance,
PR #86) reconciled **method + path**, not query-param **names** or **shapes**. Nothing
crossed the boundary with the real key, so `?event=` vs `?eventId=` surfaced only in
production. A future mobile client would reintroduce exactly this class of bug on every
release — hence a permanent guard, not a one-off fix.

## Options considered

| Option | What | Verdict |
|---|---|---|
| (a) Shared type/schema as SoT | `@dub/types` (already declared SoT) is the one place; client & server derive from it | **Adopt now.** Already the repo's model; no new deps. The gap was enforcement, not the SoT. |
| (b) OpenAPI/zod codegen | Generate client types + Swagger UI + mobile clients from one schema | **Adopt later, incrementally.** Right long-term answer for mobile, but a 16-service migration = a big-bang change to defer to review. |
| (c) CI conformance/contract test | Reconcile client keys ⟷ spec ⟷ server in CI | **Adopt now, as the teeth for (a).** Extends the existing `@dub/e2e-smoke` harness. |

Recommended = **(a) + (c) now, (b) as the roadmap.** This fits Dub as it is today
(`@dub/types` + turbo + a `pnpm test` CI gate) and needs no new tooling or paid service.

## How gantt proves it (this PR)

- **SoT.** `packages/types/src/gantt.ts` adds `GANTT_WIRE` — a runtime descriptor mapping
  each read endpoint (by operationId) to its `method / path / query` keys. A compile-time
  guard ties the descriptor keys to `GetGanttQuery`, so the descriptor and the type can't
  drift.
- **Client derives.** `apps/fe4-task-gantt/src/api/endpoints.ts` builds each gantt query
  as a typed `gantt.GetGanttQuery` object, so the wire key IS the SoT field name. The old
  `?event=` is gone. The mock (`mock-client.ts`) now reads the same `eventId` key the
  server does — it can no longer mirror a client-local mistake.
- **CI teeth (client side).** `apps/fe4-task-gantt/test/endpoints-wire-contract.test.ts`
  spies on the real `RequestInput` each endpoint emits and asserts its query keys equal
  `GANTT_WIRE`. Reintroducing `{ event: eventId }` turns it red
  (`expected [ 'event' ] to deeply equal [ 'eventId' ]` — verified).
- **CI teeth (spec + server side).** `packages/e2e-smoke/test/wire-params.test.ts`
  reconciles `GANTT_WIRE` against the OpenAPI spec's `in: query` params (per operationId)
  and against the server's `c.req.query("...")` reads. A server drift to `query("event")`
  turns it red (verified).

Result: the exact production bug now fails CI on any of the three sides.

## Rollout to other endpoints (per service, incremental — do NOT big-bang)

1. Add a `<SVC>_WIRE` descriptor to that service's `@dub/types` namespace (operationId ->
   `{ method, path, query }`), with the same compile-time key guard against its query type.
2. Make the FE endpoint wrappers build queries from the typed query interface (never a
   renamed literal key).
3. Add the two conformance tests for the service (client spy test in the FE app; the
   spec+server reconciliation in `@dub/e2e-smoke` — the extractor already keys by
   operationId, so most services need only a new `describe` block).
4. Ensure the FE mock reads the SoT keys (so mocks can't re-encode a client-local belief).

For request/response **shapes** (not just query keys), follow the existing fe6 pattern
(`apps/fe6-chat/src/api/contract-conformance.test.ts`): zod-validate mock payloads against
the `@dub/types` shape, plus a compile-time assignability check to the frozen type.

## Operating rule (people, not just CI)

- **Design the wire contract first.** A new/changed endpoint updates `@dub/types` + its
  OpenAPI spec **before** either side codes against it. The SoT change is the contract.
- **Changing a wire param = a contract change.** Rename the key in the SoT; CI then tells
  every side that must follow. Never "fix" a mismatch by editing only one side to agree
  with the other's wrong belief.
- **When a key might drift, front and back talk.** If FE and a service owner are unsure of
  a name/shape, agree it on the SoT PR before implementing — do not each guess.

## Mobile (MO1 iOS / MO2 Android via mo3-mobile-bff)

Mobile multiplies the risk: another independent client re-deriving the wire on every
release. The same rule holds — the mobile BFF endpoints get `MO3_WIRE` descriptors and the
same reconciliation tests. When option (b) lands, generate the mobile client types from the
same OpenAPI specs so the phone literally cannot compile a `?event=`.
