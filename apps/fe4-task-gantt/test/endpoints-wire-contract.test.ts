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
import { gantt, task } from "@dub/types";
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

// Same guard for the 送る・受け取る (send/receive) endpoints against task.TASK_REQUEST_WIRE.
describe("send/receive endpoints conform to the task.TASK_REQUEST_WIRE contract", () => {
  const W = task.TASK_REQUEST_WIRE;

  it("listTaskCrossLinks: exact query key = eventId", () => {
    const { client, calls } = spyClient();
    void api.listTaskCrossLinks(client, EVENT_ID);
    const req = calls[0]!;
    expect(req.method).toBe(W.listTaskCrossLinks.method);
    expect(req.path.endsWith(W.listTaskCrossLinks.path)).toBe(true);
    expect(Object.keys(req.query ?? {})).toEqual([...W.listTaskCrossLinks.query]);
    expect((req.query ?? {}).eventId).toBe(EVENT_ID);
  });

  it("listTaskRequests: every emitted query key is from the wire set (no hand-renamed keys)", () => {
    const { client, calls } = spyClient();
    void api.listTaskRequests(client, { box: "incoming", state: ["pending"], eventId: EVENT_ID, cursor: "c1", limit: 20 });
    const req = calls[0]!;
    expect(req.method).toBe(W.listTaskRequests.method);
    expect(req.path.endsWith(W.listTaskRequests.path)).toBe(true);
    for (const k of Object.keys(req.query ?? {})) expect(W.listTaskRequests.query).toContain(k);
    expect((req.query ?? {}).box).toBe("incoming");
    expect((req.query ?? {}).state).toBe("pending"); // array serialized as csv under `state`
    expect((req.query ?? {}).eventId).toBe(EVENT_ID);
  });

  it("issue/get/accept/decline/cancel: method + path honour the wire, no query", () => {
    const cases: { name: keyof typeof W; run: (c: ApiClient) => void }[] = [
      { name: "issueTaskRequest", run: (c) => void api.issueTaskRequest(c, { toUserId: "usr_x", title: "t" }) },
      { name: "getTaskRequest", run: (c) => void api.getTaskRequest(c, "treq_1") },
      { name: "acceptTaskRequest", run: (c) => void api.acceptTaskRequest(c, "treq_1", { version: 1 }) },
      { name: "declineTaskRequest", run: (c) => void api.declineTaskRequest(c, "treq_1", { version: 1 }) },
      { name: "cancelTaskRequest", run: (c) => void api.cancelTaskRequest(c, "treq_1", { version: 1 }) },
    ];
    for (const { name, run } of cases) {
      const { client, calls } = spyClient();
      run(client);
      const req = calls[0]!;
      expect(req.method).toBe(W[name].method);
      expect(req.path.endsWith(W[name].path.replace("{id}", "treq_1"))).toBe(true);
      expect(Object.keys(req.query ?? {})).toEqual([]);
    }
  });
});
