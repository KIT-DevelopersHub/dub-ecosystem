import { describe, it, expect, vi } from "vitest";
import { MobileBffClient } from "../src/bff-client";
import { GanttViewModel } from "../src/gantt";
import { InMemorySessionStore } from "../src/session-store";
import { makeMockServer, errorBody, type MockServer } from "./helpers";

function chart(rows: unknown[] = []) {
  return { eventId: "evt_1", rows, dependencies: [] };
}
const ROW = {
  taskId: "tsk_1",
  title: "Design",
  startsAt: "2026-08-01T00:00:00Z",
  endsAt: "2026-08-05T00:00:00Z",
  progressPercent: 0,
  assigneeId: "usr_1",
};
const VIEW = { eventId: "evt_1", zoom: "month", collapsedTaskIds: ["tsk_1"] };

function setup(server: MockServer, eventId = "evt_1") {
  const store = new InMemorySessionStore();
  store.setSession("tok_1", "r_1");
  const client = new MobileBffClient({ fetchFn: server.fetch, store, onLogout: vi.fn() });
  return { vm: new GanttViewModel(client, eventId), server };
}

describe("GanttViewModel — S11 MVI UiState (§2-2, §7)", () => {
  it("load success -> content, chart + persisted view applied", async () => {
    const server = makeMockServer(
      { status: 200, body: chart([ROW]) }, // GET /gantt
      { status: 200, body: VIEW }, // GET /gantt/view
    );
    const { vm } = setup(server);
    await vm.onEvent({ type: "load" });
    expect(vm.uiState.status).toBe("content");
    if (vm.uiState.status === "content") {
      expect(vm.uiState.isEmpty).toBe(false);
      expect(vm.uiState.chart.rows).toHaveLength(1);
      expect(vm.uiState.view.zoom).toBe("month");
      expect(vm.uiState.view.collapsedTaskIds).toEqual(["tsk_1"]);
    }
    expect(server.requests[0]!.url).toContain("/m/v1/gantt?event=evt_1");
    expect(server.requests[1]!.url).toContain("/m/v1/gantt/view?event=evt_1");
  });

  it("empty chart -> content with isEmpty=true and default view", async () => {
    const server = makeMockServer(
      { status: 200, body: chart([]) },
      { status: 200, body: { eventId: "evt_1", zoom: "week", collapsedTaskIds: [] } },
    );
    const { vm } = setup(server);
    await vm.onEvent({ type: "load" });
    if (vm.uiState.status === "content") {
      expect(vm.uiState.isEmpty).toBe(true);
      expect(vm.uiState.view.zoom).toBe("week");
    } else throw new Error("expected content");
  });

  it("view-pref read failure degrades gracefully (chart still loads)", async () => {
    const server = makeMockServer(
      { status: 200, body: chart([ROW]) }, // chart ok
      { status: 500, body: errorBody("INTERNAL") }, // view read fails
    );
    const { vm } = setup(server);
    await vm.onEvent({ type: "load" });
    expect(vm.uiState.status).toBe("content"); // chart is not blanked by a failed pref read
    if (vm.uiState.status === "content") expect(vm.uiState.view.zoom).toBe("week"); // default
  });

  it("chart load failure -> error, keeps last-good cache (stale-while-error)", async () => {
    const server = makeMockServer(
      { status: 200, body: chart([ROW]) }, // load#1 chart
      { status: 200, body: VIEW }, // load#1 view
      { status: 500, body: errorBody("INTERNAL") }, // refresh chart fails
    );
    const { vm } = setup(server);
    await vm.onEvent({ type: "load" });
    await vm.onEvent({ type: "refresh" });
    expect(vm.uiState.status).toBe("error");
    if (vm.uiState.status === "error") {
      expect(vm.uiState.error.kind).toBe("Server");
      expect(vm.uiState.cached?.rows).toHaveLength(1); // last-good chart retained
    }
  });

  it("setZoom optimistically updates view and PATCHes /gantt/view", async () => {
    const server = makeMockServer(
      { status: 200, body: chart([ROW]) },
      { status: 200, body: { eventId: "evt_1", zoom: "week", collapsedTaskIds: [] } },
      { status: 200, body: { eventId: "evt_1", zoom: "day", collapsedTaskIds: [] } }, // save ack
    );
    const { vm } = setup(server);
    await vm.onEvent({ type: "load" });
    await vm.onEvent({ type: "setZoom", zoom: "day" });
    if (vm.uiState.status === "content") expect(vm.uiState.view.zoom).toBe("day");
    else throw new Error("expected content");
    const save = server.requests[2]!;
    expect(save.method).toBe("PATCH");
    expect(save.url).toContain("/m/v1/gantt/view?event=evt_1");
    expect(save.body).toEqual({ zoom: "day", collapsedTaskIds: [] });
  });

  it("toggleCollapse adds then removes a task id (optimistic)", async () => {
    const server = makeMockServer(
      { status: 200, body: chart([ROW]) },
      { status: 200, body: { eventId: "evt_1", zoom: "week", collapsedTaskIds: [] } },
      { status: 200, body: {} }, // save#1
      { status: 200, body: {} }, // save#2
    );
    const { vm } = setup(server);
    await vm.onEvent({ type: "load" });
    await vm.onEvent({ type: "toggleCollapse", taskId: "tsk_1" });
    if (vm.uiState.status === "content") expect(vm.uiState.view.collapsedTaskIds).toEqual(["tsk_1"]);
    await vm.onEvent({ type: "toggleCollapse", taskId: "tsk_1" });
    if (vm.uiState.status === "content") expect(vm.uiState.view.collapsedTaskIds).toEqual([]);
  });

  it("a failed view-pref save is swallowed, local view stays applied", async () => {
    const server = makeMockServer(
      { status: 200, body: chart([ROW]) },
      { status: 200, body: { eventId: "evt_1", zoom: "week", collapsedTaskIds: [] } },
      { status: 500, body: errorBody("INTERNAL") }, // save fails
    );
    const { vm } = setup(server);
    await vm.onEvent({ type: "load" });
    await expect(vm.onEvent({ type: "setZoom", zoom: "day" })).resolves.toBeUndefined();
    if (vm.uiState.status === "content") expect(vm.uiState.view.zoom).toBe("day");
    else throw new Error("expected content");
  });

  it("emits loading before first content", async () => {
    const server = makeMockServer(
      { status: 200, body: chart([]) },
      { status: 200, body: { eventId: "evt_1", zoom: "week", collapsedTaskIds: [] } },
    );
    const { vm } = setup(server);
    const statuses: string[] = [];
    vm.subscribe((s) => statuses.push(s.status));
    await vm.onEvent({ type: "load" });
    expect(statuses[0]).toBe("loading");
    expect(statuses.at(-1)).toBe("content");
  });
});
