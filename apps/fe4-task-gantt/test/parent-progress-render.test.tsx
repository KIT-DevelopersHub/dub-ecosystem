import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { common, gantt, task } from "@dub/types";
import { GanttView } from "../src/components/GanttView";

// Parent p with 4 children; a wide span so the parent bar draws its inside label
// (and thus the "n/m 完了" count) at week zoom.
const dto: gantt.GanttChartDTO = {
  eventId: "evt_1",
  rows: [
    { taskId: "p", title: "設計フェーズ", startsAt: "2026-08-01T00:00:00Z", endsAt: "2026-09-30T00:00:00Z", progressPercent: 0, assigneeId: null, depth: 0, hasChildren: true },
    { taskId: "c1", title: "子1", startsAt: "2026-08-01T00:00:00Z", endsAt: "2026-08-10T00:00:00Z", progressPercent: 0, assigneeId: null, parentTaskId: "p", depth: 1 },
    { taskId: "c2", title: "子2", startsAt: "2026-08-11T00:00:00Z", endsAt: "2026-08-20T00:00:00Z", progressPercent: 0, assigneeId: null, parentTaskId: "p", depth: 1 },
    { taskId: "c3", title: "子3", startsAt: "2026-08-21T00:00:00Z", endsAt: "2026-08-31T00:00:00Z", progressPercent: 0, assigneeId: null, parentTaskId: "p", depth: 1 },
    { taskId: "c4", title: "子4", startsAt: "2026-09-01T00:00:00Z", endsAt: "2026-09-30T00:00:00Z", progressPercent: 0, assigneeId: null, parentTaskId: "p", depth: 1 },
  ],
  dependencies: [],
};

const statusMap = (m: Record<string, task.TaskStatus>): ReadonlyMap<common.TaskId, task.TaskStatus> =>
  new Map(Object.entries(m));

describe("親バーが子のステータス割合を色＋n/mで表す", () => {
  it("親バーに『n/m 完了』とステータス別スライスが出る（3/4 完了）", () => {
    render(
      <GanttView
        dto={dto}
        zoom="week"
        statusById={statusMap({ p: "in_progress", c1: "done", c2: "done", c3: "done", c4: "in_progress" })}
      />,
    );
    const bar = screen.getByTestId("fe4-gantt-bar-p");
    expect(bar).toHaveAttribute("data-child-done", "3");
    expect(bar).toHaveAttribute("data-child-total", "4");
    expect(screen.getByTestId("fe4-gantt-count-p")).toHaveTextContent("3/4 完了");
    // one slice per present status: done + in_progress = 2
    const segTrack = screen.getByTestId("fe4-gantt-segs-p");
    expect(segTrack.querySelectorAll("[data-status]")).toHaveLength(2);
    expect(segTrack.querySelector('[data-status="done"]')).not.toBeNull();
    expect(segTrack.querySelector('[data-status="in_progress"]')).not.toBeNull();
  });

  it("子のステータスを完了に変えると割合と n/m が変わる（3/4 → 4/4・単色）", () => {
    const { rerender } = render(
      <GanttView
        dto={dto}
        zoom="week"
        statusById={statusMap({ c1: "done", c2: "done", c3: "done", c4: "in_progress" })}
      />,
    );
    expect(screen.getByTestId("fe4-gantt-count-p")).toHaveTextContent("3/4 完了");

    // flip the last child to done → parent is fully complete, one green slice
    rerender(
      <GanttView
        dto={dto}
        zoom="week"
        statusById={statusMap({ c1: "done", c2: "done", c3: "done", c4: "done" })}
      />,
    );
    const bar = screen.getByTestId("fe4-gantt-bar-p");
    expect(bar).toHaveAttribute("data-child-done", "4");
    expect(screen.getByTestId("fe4-gantt-count-p")).toHaveTextContent("4/4 完了");
    const segs = screen.getByTestId("fe4-gantt-segs-p").querySelectorAll("[data-status]");
    expect(segs).toHaveLength(1);
    expect(segs[0]!.getAttribute("data-status")).toBe("done");
  });

  it("葉タスクには子進捗の n/m を出さない", () => {
    render(
      <GanttView
        dto={dto}
        zoom="week"
        statusById={statusMap({ c1: "done", c2: "todo", c3: "todo", c4: "todo" })}
      />,
    );
    // children are hidden until the parent is expanded, but even so leaves never get a count node
    expect(screen.queryByTestId("fe4-gantt-count-c1")).toBeNull();
  });
});
