// Wire-contract conformance for the event-service endpoints (fe3 client ↔ @dub/types SoT).
//
// This is the fe3 analogue of the fe4 gantt guard that the `?event=` vs `?eventId=`
// production drift needed. The existing eventApi.test.ts exercises the *mock* (behaviour),
// never the query-parameter *names* the real client puts on the wire. Here we spy on the
// exact RequestInput createHttpEventApi emits and reconcile its query keys against
// event.EVENT_WIRE — the single source of truth the server + OpenAPI spec are ALSO
// reconciled against (see @dub/e2e-smoke wire-params.test.ts). Hand-renaming a wire key
// inside createHttpEventApi (e.g. `{ stage: query.phase }`) turns this suite red.
import { describe, it, expect } from "vitest";
import { event } from "@dub/types";
import type { ApiClient, RequestInput } from "../src/contracts/fe2";
import { createHttpEventApi } from "../src/api/eventApi";

/** Minimal spy: captures each RequestInput; only `request` is exercised here. */
function spyClient(): { client: ApiClient; calls: RequestInput[] } {
  const calls: RequestInput[] = [];
  const client = {
    request: <TRes,>(input: RequestInput): Promise<TRes> => {
      calls.push(input);
      return Promise.resolve({ items: [], nextCursor: null } as unknown as TRes);
    },
  } as unknown as ApiClient;
  return { client, calls };
}

const EVENT_ID = "evt_wire_1";

describe("event endpoints conform to the @dub/types wire contract (query keys)", () => {
  it("listEvents: emits exactly EVENT_WIRE.listEvents query keys", () => {
    const { client, calls } = spyClient();
    const api = createHttpEventApi(client);
    // Build the query AS the typed contract so its keys ARE the SoT field names; a
    // renamed key can no longer reach the wire without a type error at the call site.
    const q: event.ListEventsQuery = {
      cursor: "c1",
      limit: 10,
      phase: "open",
      startsAfter: "2026-01-01T00:00:00Z",
      sort: "startsAt",
      includeArchived: true,
    };
    void api.listEvents(q);
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req.method).toBe(event.EVENT_WIRE.listEvents.method);
    expect(req.path.endsWith(event.EVENT_WIRE.listEvents.path)).toBe(true);
    // The crux: the wire query KEYS must equal the contract exactly.
    expect(Object.keys(req.query ?? {}).sort()).toEqual([...event.EVENT_WIRE.listEvents.query].sort());
  });

  it("listActions: emits exactly EVENT_WIRE.listActions query keys", () => {
    const { client, calls } = spyClient();
    const api = createHttpEventApi(client);
    const q: event.ListActionsQuery = { cursor: "c2", limit: 5, kind: "generic", includeArchived: true };
    void api.listActions(EVENT_ID, q);
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req.method).toBe(event.EVENT_WIRE.listActions.method);
    expect(req.path.endsWith("/actions")).toBe(true); // path carries a middle {id} param
    expect(Object.keys(req.query ?? {}).sort()).toEqual([...event.EVENT_WIRE.listActions.query].sort());
  });
});
