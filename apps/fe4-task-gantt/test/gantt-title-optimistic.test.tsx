// A detail-panel rename must reflect on the gantt the SAME tick, from the store
// (task-service = the authority on title) — never waiting on, nor reverting to, the
// gantt read model's denormalized row title. GanttView therefore prefers the
// `titleOverrides` map (store titles) over `dto.rows[].title`. This is the unit-level
// guard for the "タイトルを変えてもリロードしないと反映されない" bug.
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { common, gantt } from "@dub/types";
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
  rows: [row({ taskId: "t1", title: "古いタイトル" })],
  dependencies: [],
};

describe("gantt title reflects the store override (optimistic rename)", () => {
  it("renders the store title, not the stale DTO row title, on the left-pane row", () => {
    const titleOverrides = new Map<common.TaskId, string>([["t1", "新しいタイトル"]]);
    render(<GanttView dto={dto} zoom="week" titleOverrides={titleOverrides} />);
    const rowEl = screen.getByTestId("fe4-gantt-row-t1");
    expect(within(rowEl).getByText("新しいタイトル")).toBeInTheDocument();
    expect(screen.queryByText("古いタイトル")).toBeNull();
  });

  it("renders the store title on the timeline bar label too", () => {
    const titleOverrides = new Map<common.TaskId, string>([["t1", "新しいタイトル"]]);
    render(<GanttView dto={dto} zoom="week" titleOverrides={titleOverrides} />);
    const bar = screen.getByTestId("fe4-gantt-bar-t1");
    // the bar's tooltip (title attr) and its inner label both use the fresh title
    expect(bar).toHaveAttribute("title", "新しいタイトル");
    expect(within(bar).getByText("新しいタイトル")).toBeInTheDocument();
  });

  it("falls back to the DTO row title when no override is present for a task", () => {
    render(<GanttView dto={dto} zoom="week" titleOverrides={new Map()} />);
    expect(within(screen.getByTestId("fe4-gantt-row-t1")).getByText("古いタイトル")).toBeInTheDocument();
  });
});
