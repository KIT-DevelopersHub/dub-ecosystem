import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { gantt } from "@dub/types";
import { GanttView } from "../src/components/GanttView";
import { TaskDetailPanel } from "../src/components/TaskDetailPanel";
import type { task } from "@dub/types";

// jsdom ships no PointerEvent, so fireEvent.pointer* drops clientX — drags then
// read NaN and never register movement. Polyfill it off MouseEvent (which carries
// clientX), and stub pointer-capture (jsdom throws for untracked pointers).
beforeAll(() => {
  if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent === "undefined") {
    class PointerEventPolyfill extends MouseEvent {
      pointerId: number;
      constructor(type: string, params: PointerEventInit = {}) {
        super(type, params);
        this.pointerId = params.pointerId ?? 1;
      }
    }
    (globalThis as { PointerEvent?: unknown }).PointerEvent = PointerEventPolyfill;
  }
  (Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
  (Element.prototype as unknown as { releasePointerCapture: () => void }).releasePointerCapture = () => {};
});

// parent p with two children c1,c2 (rolled span = union of the children).
const wbsDto: gantt.GanttChartDTO = {
  eventId: "evt_1",
  rows: [
    { taskId: "p", title: "設計フェーズ", startsAt: "2026-08-12T00:00:00Z", endsAt: "2026-08-13T00:00:00Z", progressPercent: 0, assigneeId: null, depth: 0, hasChildren: true },
    { taskId: "c1", title: "子1", startsAt: "2026-08-05T00:00:00Z", endsAt: "2026-08-09T00:00:00Z", progressPercent: 0, assigneeId: null, parentTaskId: "p", depth: 1 },
    { taskId: "c2", title: "子2", startsAt: "2026-08-15T00:00:00Z", endsAt: "2026-08-22T00:00:00Z", progressPercent: 0, assigneeId: null, parentTaskId: "p", depth: 1 },
  ],
  dependencies: [],
};

describe("#39-1 wide toggle hit area (left gutter toggles, not just the glyph)", () => {
  it("clicking the toggle opens children and does NOT open the detail panel", () => {
    const onSelect = vi.fn();
    render(<GanttView dto={wbsDto} zoom="week" onSelect={onSelect} />);
    expect(screen.queryByTestId("fe4-gantt-row-c1")).toBeNull();
    fireEvent.click(screen.getByTestId("fe4-gantt-toggle-p"));
    expect(screen.getByTestId("fe4-gantt-row-c1")).toBeInTheDocument(); // toggled open
    expect(onSelect).not.toHaveBeenCalled(); // gutter click ≠ open detail
  });

  it("clicking the row label area still opens the detail (onSelect)", () => {
    const onSelect = vi.fn();
    render(<GanttView dto={wbsDto} zoom="week" onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId("fe4-gantt-row-p"));
    expect(onSelect).toHaveBeenCalledWith("p");
  });
});

describe("#39-2 parent bar is draggable: a move shifts the whole subtree", () => {
  it("dragging the parent bar calls onScheduleShift (children follow), not onSchedule", () => {
    const onSchedule = vi.fn();
    const onScheduleShift = vi.fn();
    render(<GanttView dto={wbsDto} zoom="day" onSchedule={onSchedule} onScheduleShift={onScheduleShift} canWrite />);
    const bar = screen.getByTestId("fe4-gantt-bar-p");
    const scroll = screen.getByTestId("fe4-gantt-scroll");
    fireEvent.pointerDown(bar, { clientX: 200, pointerId: 1 });
    fireEvent.pointerMove(scroll, { clientX: 300, pointerId: 1 }); // +100px past the click threshold
    fireEvent.pointerUp(scroll, { clientX: 300, pointerId: 1 });
    expect(onScheduleShift).toHaveBeenCalledTimes(1);
    const [id, delta] = onScheduleShift.mock.calls[0]!;
    expect(id).toBe("p");
    expect(delta).not.toBe(0); // shifted by whole days (100px / 34px-per-day ≈ 3)
    expect(onSchedule).not.toHaveBeenCalled(); // parent move does NOT persist a single row
  });

  it("resizing the parent edge persists the parent's own span via onSchedule", () => {
    const onSchedule = vi.fn();
    const onScheduleShift = vi.fn();
    render(<GanttView dto={wbsDto} zoom="day" onSchedule={onSchedule} onScheduleShift={onScheduleShift} canWrite />);
    const handle = screen.getByTestId("fe4-gantt-bar-p-rz-r");
    const scroll = screen.getByTestId("fe4-gantt-scroll");
    fireEvent.pointerDown(handle, { clientX: 200, pointerId: 1 });
    fireEvent.pointerMove(scroll, { clientX: 300, pointerId: 1 });
    fireEvent.pointerUp(scroll, { clientX: 300, pointerId: 1 });
    expect(onSchedule).toHaveBeenCalledTimes(1);
    expect(onSchedule.mock.calls[0]![0]).toBe("p");
    expect(onScheduleShift).not.toHaveBeenCalled();
  });
});

const mkParent = (id: string): task.Task => ({
  id, eventId: "evt_1", title: "設計フェーズ", description: null, status: "todo",
  priority: "medium", assigneeId: null, dueAt: "2026-08-20T00:00:00Z", origin: "internal",
  archivedAt: null, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", version: 1,
});

describe("#39-3 parent detail shows the child count", () => {
  it("renders 子タスク: N個 when the task has children", () => {
    render(
      <TaskDetailPanel
        task={mkParent("p")}
        users={[]}
        canWrite
        canDelete
        onSave={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
        scopeTasks={[
          { id: "p", title: "設計フェーズ", parentTaskId: null, teamId: null },
          { id: "c1", title: "子1", parentTaskId: "p", teamId: null },
          { id: "c2", title: "子2", parentTaskId: "p", teamId: null },
        ]}
      />,
    );
    const chip = screen.getByTestId("fe4-detail-child-count");
    expect(chip.textContent).toMatch(/子タスク/);
    expect(chip.textContent).toMatch(/2個/);
  });

  it("hides the child count for a leaf task (no children)", () => {
    render(
      <TaskDetailPanel
        task={mkParent("leaf")}
        users={[]}
        canWrite
        canDelete
        onSave={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
        scopeTasks={[{ id: "leaf", title: "葉", parentTaskId: null, teamId: null }]}
      />,
    );
    expect(screen.queryByTestId("fe4-detail-child-count")).toBeNull();
  });
});
