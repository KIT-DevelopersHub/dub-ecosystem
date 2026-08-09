import { describe, it, expect } from "vitest";
import type { gantt } from "@dub/types";
import { buildGanttViewModel, dependencyOrder, dateRange, dayDiff, toPutGanttViewRequest } from "../src/gantt.js";
import { MobileApiClient } from "../src/api-client.js";
import { InMemoryTokenStore } from "../src/token-store.js";
import { ok, scriptedTransport } from "./helpers.js";

const BASE = "https://m-api.developershub.jp";
const noSleep = async (): Promise<void> => {};

function seededStore(): InMemoryTokenStore {
  const store = new InMemoryTokenStore();
  store.write({ token: "tok", sessionExpiresAt: Date.now() + 3_600_000 });
  return store;
}

function row(over: Partial<gantt.GanttRow> & { taskId: string }): gantt.GanttRow {
  return {
    title: over.taskId,
    startsAt: null,
    endsAt: null,
    progressPercent: 0,
    assigneeId: null,
    ...over,
  };
}

function fs(from: string, to: string): gantt.GanttDependencyLine {
  return { id: `${from}->${to}`, fromTaskId: from, toTaskId: to, type: "FS", lagDays: 0 };
}

describe("gantt date math", () => {
  it("dayDiff counts whole days and collapses bad input to 0", () => {
    expect(dayDiff("2026-08-01T00:00:00Z", "2026-08-06T00:00:00Z")).toBe(5);
    expect(dayDiff("2026-08-06T00:00:00Z", "2026-08-01T00:00:00Z")).toBe(-5);
    expect(dayDiff("nonsense", "2026-08-06T00:00:00Z")).toBe(0);
  });

  it("dateRange spans earliest start to latest end, skipping unscheduled", () => {
    const range = dateRange([
      { id: "a", startsAt: "2026-08-03T00:00:00Z", endsAt: "2026-08-05T00:00:00Z", durationDays: 2 },
      { id: "b", startsAt: "2026-08-01T00:00:00Z", endsAt: "2026-08-10T00:00:00Z", durationDays: 9 },
      { id: "c", startsAt: null, endsAt: null, durationDays: 0 },
    ]);
    expect(range.start).toBe("2026-08-01T00:00:00Z");
    expect(range.end).toBe("2026-08-10T00:00:00Z");
    expect(range.totalDays).toBe(9);
  });

  it("dateRange is null/0 when nothing is scheduled", () => {
    expect(dateRange([{ id: "a", startsAt: null, endsAt: null, durationDays: 0 }])).toEqual({
      start: null,
      end: null,
      totalDays: 0,
    });
  });
});

describe("dependencyOrder (依存順序)", () => {
  it("orders predecessors before successors and assigns depth", () => {
    // c depends on b, b depends on a  =>  a, b, c
    const tasks = [
      { id: "c", startsAt: null, endsAt: null, durationDays: 0 },
      { id: "a", startsAt: null, endsAt: null, durationDays: 0 },
      { id: "b", startsAt: null, endsAt: null, durationDays: 0 },
    ];
    const deps = [
      { taskId: "c", dependsOnId: "b" },
      { taskId: "b", dependsOnId: "a" },
    ];
    const { order, depth, hasCycle } = dependencyOrder(tasks, deps);
    expect(order).toEqual(["a", "b", "c"]);
    expect(depth).toEqual({ a: 0, b: 1, c: 2 });
    expect(hasCycle).toBe(false);
  });

  it("keeps source order among independent rows (stable)", () => {
    const tasks = ["x", "y", "z"].map((id) => ({ id, startsAt: null, endsAt: null, durationDays: 0 }));
    expect(dependencyOrder(tasks, []).order).toEqual(["x", "y", "z"]);
  });

  it("ignores dependencies referencing unknown tasks", () => {
    const tasks = [{ id: "a", startsAt: null, endsAt: null, durationDays: 0 }];
    const { order, hasCycle } = dependencyOrder(tasks, [{ taskId: "a", dependsOnId: "ghost" }]);
    expect(order).toEqual(["a"]);
    expect(hasCycle).toBe(false);
  });

  it("flags a cycle and falls back to source order instead of throwing", () => {
    const tasks = ["a", "b"].map((id) => ({ id, startsAt: null, endsAt: null, durationDays: 0 }));
    const deps = [
      { taskId: "a", dependsOnId: "b" },
      { taskId: "b", dependsOnId: "a" },
    ];
    const { order, hasCycle } = dependencyOrder(tasks, deps);
    expect(hasCycle).toBe(true);
    expect(order).toEqual(["a", "b"]);
  });
});

describe("buildGanttViewModel (S6 view-model)", () => {
  const dto: gantt.GanttChartDTO = {
    eventId: "evt_1",
    rows: [
      row({ taskId: "design", startsAt: "2026-08-05T00:00:00Z", endsAt: "2026-08-07T00:00:00Z", progressPercent: 100 }),
      row({ taskId: "spec", startsAt: "2026-08-01T00:00:00Z", endsAt: "2026-08-03T00:00:00Z" }),
      row({ taskId: "build", startsAt: "2026-08-07T00:00:00Z", endsAt: "2026-08-12T00:00:00Z" }),
    ],
    dependencies: [fs("spec", "design"), fs("design", "build")],
  };

  it("orders rows by FS dependency and computes offset/duration within the range", () => {
    const vm = buildGanttViewModel(dto);
    expect(vm.rows.map((r) => r.taskId)).toEqual(["spec", "design", "build"]);
    expect(vm.range.start).toBe("2026-08-01T00:00:00Z");
    expect(vm.range.end).toBe("2026-08-12T00:00:00Z");
    expect(vm.hasCycle).toBe(false);

    const design = vm.rows.find((r) => r.taskId === "design")!;
    expect(design.offsetDays).toBe(4); // Aug1 -> Aug5
    expect(design.durationDays).toBe(2); // Aug5 -> Aug7
    expect(design.depth).toBe(1);
    expect(design.progressPercent).toBe(100);

    const spec = vm.rows.find((r) => r.taskId === "spec")!;
    expect(spec.offsetDays).toBe(0);
    expect(spec.depth).toBe(0);
  });

  it("defaults zoom to week and honours the persisted view state", () => {
    expect(buildGanttViewModel(dto).zoom).toBe("week");
    const vm = buildGanttViewModel(dto, { viewState: { zoom: "month", collapsedTaskIds: ["build"] } });
    expect(vm.zoom).toBe("month");
    expect(vm.collapsedTaskIds).toEqual(["build"]);
    expect(vm.rows.find((r) => r.taskId === "build")!.collapsed).toBe(true);
    expect(vm.rows.find((r) => r.taskId === "spec")!.collapsed).toBe(false);
  });

  it("leaves unscheduled rows with a null offset", () => {
    const vm = buildGanttViewModel({
      eventId: "evt_2",
      rows: [row({ taskId: "later", startsAt: null, endsAt: null }), row({ taskId: "s", startsAt: "2026-08-01T00:00:00Z", endsAt: "2026-08-02T00:00:00Z" })],
      dependencies: [],
    });
    expect(vm.rows.find((r) => r.taskId === "later")!.offsetDays).toBeNull();
    expect(vm.rows.find((r) => r.taskId === "later")!.durationDays).toBe(0);
  });

  it("toPutGanttViewRequest projects the persisted fields", () => {
    expect(toPutGanttViewRequest({ zoom: "day", collapsedTaskIds: ["a"] })).toEqual({
      zoom: "day",
      collapsedTaskIds: ["a"],
    });
  });
});

describe("MobileApiClient gantt read (/m/v1/gantt)", () => {
  it("GETs the chart with the eventId query", async () => {
    const store = seededStore();
    const chart: gantt.GanttChartDTO = { eventId: "evt_1", rows: [], dependencies: [] };
    const { transport, calls } = scriptedTransport([ok(chart)]);
    const client = new MobileApiClient({ baseUrl: BASE, transport, tokenStore: store, sleep: noSleep });

    const res = await client.getGantt({ eventId: "evt_1" });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/m/v1/gantt");
    expect(url.searchParams.get("eventId")).toBe("evt_1");
    expect(calls[0]!.headers.authorization).toBe("Bearer tok");
    expect(res).toEqual(chart);
  });
});
