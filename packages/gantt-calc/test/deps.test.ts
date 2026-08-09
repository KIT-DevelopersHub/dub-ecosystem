import { describe, it, expect } from "vitest";
import type { ganttCalc } from "@dub/types";
import { computeSchedule, computeCriticalPath } from "../src/index";

const t = (id: string, durationDays: number, startsAt: string | null = null): ganttCalc.GanttCalcTask => ({
  id,
  startsAt,
  endsAt: null,
  durationDays,
});
const dep = (
  taskId: string,
  dependsOnId: string,
  kind?: ganttCalc.GanttCalcDependencyKind,
  lagDays?: number,
): ganttCalc.GanttCalcDependency => ({ taskId, dependsOnId, kind, lagDays });

// Convenience: earliest/latest of a node in day-space (calendar-day / identity mode).
const es = (s: ReturnType<typeof computeSchedule>, id: string) => s.nodes.get(id)!.earliestStartDay;
const ef = (s: ReturnType<typeof computeSchedule>, id: string) => s.nodes.get(id)!.earliestFinishDay;
const ls = (s: ReturnType<typeof computeSchedule>, id: string) => s.nodes.get(id)!.latestStartDay;
const lf = (s: ReturnType<typeof computeSchedule>, id: string) => s.nodes.get(id)!.latestFinishDay;

describe("dependency kinds — forward pass", () => {
  it("FS (default, no kind) keeps successor after predecessor finish", () => {
    const s = computeSchedule([t("a", 2), t("b", 3)], [dep("b", "a")]);
    expect(es(s, "b")).toBe(2); // a.EF
    expect(ef(s, "b")).toBe(5);
  });

  it("FS with positive lag delays the successor", () => {
    const s = computeSchedule([t("a", 2), t("b", 3)], [dep("b", "a", "FS", 1)]);
    expect(es(s, "b")).toBe(3); // a.EF + 1
  });

  it("FS with negative lag (lead) pulls the successor earlier, floored at the anchor", () => {
    const s = computeSchedule([t("a", 2), t("b", 1)], [dep("b", "a", "FS", -1)]);
    expect(es(s, "b")).toBe(1); // max(anchor 0, a.EF-1 = 1)
  });

  it("SS ties successor start to predecessor start (+lag)", () => {
    const s0 = computeSchedule([t("a", 2), t("b", 3)], [dep("b", "a", "SS", 0)]);
    expect(es(s0, "b")).toBe(0); // == a.ES
    const s1 = computeSchedule([t("a", 2), t("b", 3)], [dep("b", "a", "SS", 1)]);
    expect(es(s1, "b")).toBe(1); // a.ES + 1
  });

  it("FF ties successor finish to predecessor finish (+lag)", () => {
    // a is longer; b(2) must finish no earlier than a.EF=6 -> b.ES = 4
    const s = computeSchedule([t("a", 6), t("b", 2)], [dep("b", "a", "FF", 0)]);
    expect(es(s, "b")).toBe(4);
    expect(ef(s, "b")).toBe(6); // == a.EF
  });

  it("SF ties successor finish to predecessor start (+lag)", () => {
    // b.EF >= a.ES + 5 = 5 -> with dur 2, b.ES = 3
    const s = computeSchedule([t("a", 3), t("b", 2)], [dep("b", "a", "SF", 5)]);
    expect(es(s, "b")).toBe(3);
    expect(ef(s, "b")).toBe(5);
  });
});

describe("dependency kinds — backward pass / slack", () => {
  it("FS chain has zero slack on both tasks", () => {
    const s = computeSchedule([t("a", 2), t("b", 3)], [dep("b", "a", "FS", 1)]);
    expect(lf(s, "a")).toBe(2); // b.LS - lag = 3 - 1
    expect(ls(s, "a")).toBe(0);
    expect(s.nodes.get("a")!.slackDays).toBe(0);
    expect(s.nodes.get("b")!.slackDays).toBe(0);
  });

  it("SS backward keeps predecessor latest-start lag-behind the successor", () => {
    const s = computeSchedule([t("a", 2), t("b", 3)], [dep("b", "a", "SS", 1)]);
    // b.LF = projEnd = 4, b.LS = 1 ; a.LF = b.LS - lag + dur(a) = 1 - 1 + 2 = 2
    expect(lf(s, "a")).toBe(2);
    expect(ls(s, "a")).toBe(0);
    expect(s.nodes.get("a")!.slackDays).toBe(0);
  });

  it("FF backward bounds predecessor finish by successor finish", () => {
    const s = computeSchedule([t("a", 6), t("b", 2)], [dep("b", "a", "FF", 0)]);
    expect(lf(s, "a")).toBe(6); // b.LF - lag
  });
});

describe("dependency kinds — critical path", () => {
  it("counts an SS-driven chain as fully critical", () => {
    const res = computeCriticalPath({
      tasks: [t("a", 2), t("b", 3)],
      dependencies: [dep("b", "a", "SS", 1)],
    });
    expect(res.criticalTaskIds).toEqual(["a", "b"]);
    expect(res.totalDurationDays).toBe(4); // projEnd 4 - projStart 0
  });

  it("is deterministic under input + kind reordering", () => {
    const tasks = [t("a", 2), t("b", 3), t("c", 1)];
    const deps = [dep("b", "a", "SS", 1), dep("c", "b", "FF", 2)];
    const a = computeSchedule(tasks, deps);
    const b = computeSchedule([...tasks].reverse(), [...deps].reverse());
    expect([...a.nodes.entries()].sort()).toEqual([...b.nodes.entries()].sort());
    expect(a.order).toEqual(b.order);
  });
});
