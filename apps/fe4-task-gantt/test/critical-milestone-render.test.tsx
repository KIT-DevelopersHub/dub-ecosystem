// Critical path + milestones must be VISIBLE, not just present in the DTO:
//  - bars on `criticalTaskIds` get the red-outline `barCritical` treatment,
//  - a dependency whose BOTH endpoints are critical is flagged `data-critical`,
//  - each `milestones[]` entry renders a diamond marker + its legend chip.
// Guards the "何が変わったか分からない" regression (data existed, UI drew nothing).
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { gantt } from "@dub/types";
import { GanttView } from "../src/components/GanttView";

const row = (over: Partial<gantt.GanttRow> & { taskId: string; title: string }): gantt.GanttRow => ({
  startsAt: "2026-08-12T00:00:00Z",
  endsAt: "2026-08-18T00:00:00Z",
  progressPercent: 0,
  assigneeId: null,
  depth: 0,
  ...over,
});

const dto: gantt.GanttChartDTO = {
  eventId: "evt_1",
  rows: [
    row({ taskId: "A", title: "タスクA", startsAt: "2026-08-10T00:00:00Z", endsAt: "2026-08-12T00:00:00Z" }),
    row({ taskId: "B", title: "タスクB", startsAt: "2026-08-12T00:00:00Z", endsAt: "2026-08-14T00:00:00Z" }),
    row({ taskId: "C", title: "タスクC", startsAt: "2026-08-14T00:00:00Z", endsAt: "2026-08-16T00:00:00Z" }),
  ],
  dependencies: [
    { id: "ab", fromTaskId: "A", toTaskId: "B", type: "FS", lagDays: 0 }, // critical link
    { id: "ac", fromTaskId: "A", toTaskId: "C", type: "FS", lagDays: 0 }, // C not critical → plain
  ],
  criticalTaskIds: ["A", "B"],
  milestones: [
    { id: "m1", date: "2026-08-14T00:00:00Z", label: "設計完了", taskId: "B" },
    { id: "m2", date: "2026-08-16T00:00:00Z", label: "リリース", taskId: null },
  ],
};

describe("critical path + milestones are visibly rendered", () => {
  it("outlines critical bars and flags the critical dependency link", () => {
    render(<GanttView dto={dto} zoom="week" />);
    // both critical bars carry the barCritical class token
    expect(screen.getByTestId("fe4-gantt-bar-A").className).toMatch(/barCritical/);
    expect(screen.getByTestId("fe4-gantt-bar-B").className).toMatch(/barCritical/);
    // a non-critical bar does not
    expect(screen.getByTestId("fe4-gantt-bar-C").className).not.toMatch(/barCritical/);
    // A→B (both critical) is flagged; A→C is not
    expect(screen.getByTestId("fe4-gantt-dep-ab")).toHaveAttribute("data-critical", "true");
    expect(screen.getByTestId("fe4-gantt-dep-ac")).not.toHaveAttribute("data-critical");
    // legend explains the red critical treatment
    expect(screen.getByTestId("fe4-gantt-guide-critical")).toBeInTheDocument();
  });

  it("renders a diamond marker + label for every milestone", () => {
    render(<GanttView dto={dto} zoom="week" />);
    expect(screen.getByTestId("fe4-gantt-milestone-m1")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-gantt-milestone-m2")).toBeInTheDocument();
    expect(screen.getByText("設計完了")).toBeInTheDocument();
    expect(screen.getByText("リリース")).toBeInTheDocument();
    // milestone legend chip is shown
    expect(screen.getByTestId("fe4-gantt-guide-milestone")).toBeInTheDocument();
  });

  it("shows neither treatment when the DTO omits critical/milestone data", () => {
    const plain: gantt.GanttChartDTO = { ...dto, criticalTaskIds: [], milestones: [] };
    render(<GanttView dto={plain} zoom="week" />);
    expect(screen.getByTestId("fe4-gantt-bar-A").className).not.toMatch(/barCritical/);
    expect(screen.queryByTestId("fe4-gantt-guide-critical")).toBeNull();
    expect(screen.queryByTestId("fe4-gantt-guide-milestone")).toBeNull();
  });
});
