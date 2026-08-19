// Dependency arrows must render for SAME-LEVEL deps (incl. top-level ↔ top-level),
// and deps whose endpoint is hidden inside a collapsed parent must aggregate onto the
// visible ancestor instead of vanishing ("トップレベル同士がほぼ見えない" fix).
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

describe("dependency arrows render for same-level deps", () => {
  it("draws an arrow between two TOP-LEVEL tasks (was reported as 'ほぼ見えない')", () => {
    const dto: gantt.GanttChartDTO = {
      eventId: "evt_1",
      rows: [
        row({ taskId: "A", title: "タスクA", startsAt: "2026-08-12T00:00:00Z", endsAt: "2026-08-14T00:00:00Z" }),
        row({ taskId: "B", title: "タスクB", startsAt: "2026-08-16T00:00:00Z", endsAt: "2026-08-20T00:00:00Z" }),
      ],
      dependencies: [{ id: "d1", fromTaskId: "A", toTaskId: "B", type: "FS", lagDays: 0 }],
    };
    render(<GanttView dto={dto} zoom="week" />);
    const arrow = screen.getByTestId("fe4-gantt-dep-d1");
    expect(arrow).toBeInTheDocument();
    expect(arrow).not.toHaveAttribute("data-aggregated"); // both endpoints directly visible
  });

  it("aggregates a dep from a COLLAPSED child onto its visible parent", () => {
    const dto: gantt.GanttChartDTO = {
      eventId: "evt_1",
      rows: [
        row({ taskId: "p", title: "設計", hasChildren: true, startsAt: "2026-08-12T00:00:00Z", endsAt: "2026-08-13T00:00:00Z" }),
        row({ taskId: "c1", title: "子1", parentTaskId: "p", depth: 1, startsAt: "2026-08-12T00:00:00Z", endsAt: "2026-08-13T00:00:00Z" }),
        row({ taskId: "X", title: "タスクX", startsAt: "2026-08-16T00:00:00Z", endsAt: "2026-08-20T00:00:00Z" }),
      ],
      // c1 (hidden under collapsed p) depends on X → must still show, redirected to p.
      dependencies: [{ id: "d2", fromTaskId: "X", toTaskId: "c1", type: "FS", lagDays: 0 }],
    };
    render(<GanttView dto={dto} zoom="week" />);
    // p is collapsed by default → c1 is not rendered…
    expect(screen.queryByTestId("fe4-gantt-row-c1")).toBeNull();
    // …but the dependency still shows, aggregated onto the visible parent p.
    const arrow = screen.getByTestId("fe4-gantt-dep-d2");
    expect(arrow).toBeInTheDocument();
    expect(arrow).toHaveAttribute("data-aggregated", "1");
  });
});
