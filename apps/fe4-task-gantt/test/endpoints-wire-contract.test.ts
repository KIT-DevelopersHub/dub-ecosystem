// Wire-contract conformance for the gantt endpoints (fe4 client ↔ @dub/types SoT).
//
// This is the test the `?event=` vs `?eventId=` production drift needed. The FE unit
// tests all stayed green because the FE mock mirrored the FE's own (wrong) query key —
// no test ever crossed the boundary to the *contract*. Here we spy on the exact
// RequestInput each endpoint puts on the wire and reconcile its query-parameter keys
// against gantt.GANTT_WIRE, the single source of truth that the server and the OpenAPI
// spec are ALSO reconciled against (see @dub/e2e-smoke wire-params.test.ts). If someone
// reintroduces `query: { event: eventId }`, this suite turns red — unmergeable.
import { describe, it, expect } from "vitest";
import { gantt } from "@dub/types";
import type { ApiClient, RequestInput } from "../src/contracts/spa-shell";
import * as api from "../src/api/endpoints";

/** Minimal spy: captures each RequestInput; only `request` is exercised here. */
function spyClient(): { client: ApiClient; calls: RequestInput[] } {
  const calls: RequestInput[] = [];
  const client = {
    request: <TRes,>(input: RequestInput): Promise<TRes> => {
      calls.push(input);
      return Promise.resolve({} as TRes);
    },
  } as unknown as ApiClient;
  return { client, calls };
}

const EVENT_ID = "evt_wire_1";

// Each SoT endpoint paired with the FE call that must honour it.
const CASES: { name: keyof typeof gantt.GANTT_WIRE; call: (c: ApiClient) => void }[] = [
  { name: "getGantt", call: (c) => void api.getGantt(c, EVENT_ID) },
  { name: "getGanttDependencies", call: (c) => void api.getGanttDependencies(c, EVENT_ID) },
  { name: "getGanttView", call: (c) => void api.getGanttView(c, EVENT_ID) },
  { name: "putGanttView", call: (c) => void api.putGanttView(c, EVENT_ID, { zoom: "week", collapsedTaskIds: [] }) },
];

describe("gantt endpoints conform to the @dub/types wire contract (query keys)", () => {
  for (const { name, call } of CASES) {
    const wire = gantt.GANTT_WIRE[name];
    it(`${name}: emits method/path/query keys from GANTT_WIRE (${wire.method} ${wire.path} ?${wire.query.join("&")})`, () => {
      const { client, calls } = spyClient();
      call(client);
      expect(calls).toHaveLength(1);
      const req = calls[0]!;
      expect(req.method).toBe(wire.method);
      expect(req.path.endsWith(wire.path)).toBe(true);
      // The crux: the wire query KEYS must equal the contract exactly. `?event=` fails here.
      expect(Object.keys(req.query ?? {}).sort()).toEqual([...wire.query].sort());
      // ...and carry the value under the contract key (not merely have the right key set).
      expect((req.query ?? {})[wire.query[0]!]).toBe(EVENT_ID);
    });
  }

  it("getGanttFresh uses the same contract key as getGantt (cache-bypass variant)", () => {
    const { client, calls } = spyClient();
    void api.getGanttFresh(client, EVENT_ID);
    expect(Object.keys(calls[0]!.query ?? {})).toEqual([...gantt.GANTT_WIRE.getGantt.query]);
  });
});
