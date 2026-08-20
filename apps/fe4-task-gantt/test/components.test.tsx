import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { gantt, task } from "@dub/types";
import { GanttView } from "../src/components/GanttView";
import { ViewSwitcher } from "../src/components/ViewSwitcher";
import { TaskListView } from "../src/components/TaskListView";
import { TaskBoardView } from "../src/components/TaskBoardView";
import { createUserCache } from "../src/domain/user-cache";
import { ROW_HEIGHT } from "../src/domain/timeline-axis";

const mk = (id: string, status: task.TaskStatus = "todo"): task.Task => ({
  id, eventId: "evt_1", title: `T-${id}`, description: null, status,
  priority: "medium", assigneeId: null, dueAt: null, origin: "internal",
  archivedAt: null, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", version: 1,
});

describe("GanttView render (design test 4/7)", () => {
  const dto: gantt.GanttChartDTO = {
    eventId: "evt_1",
    rows: [
      { taskId: "a", title: "設計", startsAt: "2026-08-01T00:00:00Z", endsAt: "2026-08-04T00:00:00Z", progressPercent: 100, assigneeId: null },
      { taskId: "b", title: "実装", startsAt: "2026-08-03T00:00:00Z", endsAt: "2026-08-08T00:00:00Z", progressPercent: 0, assigneeId: null },
      { taskId: "c", title: "未定", startsAt: null, endsAt: null, progressPercent: 0, assigneeId: null },
    ],
    dependencies: [{ id: "a->b", fromTaskId: "a", toTaskId: "b", type: "FS", lagDays: 0 }],
  };

  it("draws a row for every task, bars only for dated rows, and the dependency line", () => {
    render(<GanttView dto={dto} zoom="day" />);
    expect(screen.getByTestId("fe4-gantt-row-a")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-gantt-row-c")).toBeInTheDocument(); // null-date row still listed
    expect(screen.getByTestId("fe4-gantt-bar-a")).toBeInTheDocument();
    expect(screen.queryByTestId("fe4-gantt-bar-c")).toBeNull(); // no bar for null dates
    expect(screen.getByTestId("fe4-gantt-dep-a->b")).toBeInTheDocument();
  });

  it("shows truncated banner when flagged (8-8)", () => {
    render(<GanttView dto={dto} zoom="week" truncated />);
    expect(screen.getByTestId("fe4-gantt-truncated")).toBeInTheDocument();
  });

  it("always renders the parent-child vs dependency guide legend (feedback #3)", () => {
    render(<GanttView dto={dto} zoom="week" />);
    const guide = screen.getByTestId("fe4-gantt-guide");
    expect(guide).toBeInTheDocument();
    expect(guide.textContent).toMatch(/親子/);
    expect(guide.textContent).toMatch(/依存/);
  });

  const wbsDto: gantt.GanttChartDTO = {
    eventId: "evt_1",
    rows: [
      { taskId: "p", title: "設計フェーズ", startsAt: "2026-08-12T00:00:00Z", endsAt: "2026-08-13T00:00:00Z", progressPercent: 0, assigneeId: null, depth: 0, hasChildren: true },
      { taskId: "c1", title: "子1", startsAt: "2026-08-05T00:00:00Z", endsAt: "2026-08-09T00:00:00Z", progressPercent: 0, assigneeId: null, parentTaskId: "p", depth: 1 },
      { taskId: "c2", title: "子2", startsAt: "2026-08-15T00:00:00Z", endsAt: "2026-08-22T00:00:00Z", progressPercent: 0, assigneeId: null, parentTaskId: "p", depth: 1 },
    ],
    dependencies: [],
  };

  it("collapses children by default and reveals them on toggle (parent-child)", () => {
    render(<GanttView dto={wbsDto} zoom="week" />);
    // parent visible, children hidden until expanded
    expect(screen.getByTestId("fe4-gantt-row-p")).toBeInTheDocument();
    expect(screen.queryByTestId("fe4-gantt-row-c1")).toBeNull();
    fireEvent.click(screen.getByTestId("fe4-gantt-toggle-p"));
    expect(screen.getByTestId("fe4-gantt-row-c1")).toBeInTheDocument();
    // expanded parent grows into its 内包バー container box (covers its children)
    const box = screen.getByTestId("fe4-gantt-group-p");
    expect(box).toBeInTheDocument();
    expect(box).toHaveAttribute("data-depth", "0");
    // container is 3 rows tall (parent + 2 children), inset by 2px top/bottom
    expect(box.style.height).toBe(`${3 * ROW_HEIGHT - 4}px`);
    expect(box.style.top).toBe("2px");
    // #369 redesign: the zone fill is a header-lane gradient (親行が濃く子が淡い), not a
    // flat faint tint — a stronger header band (20%) over the parent row stepping to the
    // 淡い body tint (12%) over the children, both from the brand token.
    expect(box.style.background).toContain("linear-gradient");
    expect(box.style.background).toContain("var(--dub-color-brand-500) 20%");
    expect(box.style.background).toContain("var(--dub-color-brand-500) 12%");
  });

  const nestedDto: gantt.GanttChartDTO = {
    eventId: "evt_1",
    rows: [
      { taskId: "gp", title: "統括", startsAt: "2026-08-01T00:00:00Z", endsAt: "2026-08-30T00:00:00Z", progressPercent: 0, assigneeId: null, depth: 0, hasChildren: true },
      { taskId: "p", title: "設計フェーズ", startsAt: "2026-08-05T00:00:00Z", endsAt: "2026-08-20T00:00:00Z", progressPercent: 0, assigneeId: null, parentTaskId: "gp", depth: 1, hasChildren: true },
      { taskId: "g1", title: "孫1", startsAt: "2026-08-05T00:00:00Z", endsAt: "2026-08-12T00:00:00Z", progressPercent: 0, assigneeId: null, parentTaskId: "p", depth: 2 },
      { taskId: "g2", title: "孫2", startsAt: "2026-08-13T00:00:00Z", endsAt: "2026-08-20T00:00:00Z", progressPercent: 0, assigneeId: null, parentTaskId: "p", depth: 2 },
    ],
    dependencies: [],
  };

  it("nests a container per level for a 3-level WBS (内包バーの入れ子)", () => {
    render(<GanttView dto={nestedDto} zoom="week" />);
    // open the grandparent, then the inner parent
    fireEvent.click(screen.getByTestId("fe4-gantt-toggle-gp"));
    fireEvent.click(screen.getByTestId("fe4-gantt-toggle-p"));
    const gpBox = screen.getByTestId("fe4-gantt-group-gp");
    const pBox = screen.getByTestId("fe4-gantt-group-p");
    // grandparent box wraps all 4 rows; inner parent box wraps its 3 — nested, deeper depth
    expect(gpBox).toHaveAttribute("data-depth", "0");
    expect(pBox).toHaveAttribute("data-depth", "1");
    expect(gpBox.style.height).toBe(`${4 * ROW_HEIGHT - 4}px`);
    expect(pBox.style.height).toBe(`${3 * ROW_HEIGHT - 4}px`);
    // Nested zones step up in body tint so the inner box reads as "inside" its ancestor:
    // depth0 body=12%, depth1 body=15%.
    expect(gpBox.style.background).toContain("var(--dub-color-brand-500) 12%");
    expect(pBox.style.background).toContain("var(--dub-color-brand-500) 15%");
  });

  it("parent bar is now draggable/resizable too (feedback #39: exposes resize handles)", () => {
    const onSchedule = vi.fn();
    render(<GanttView dto={wbsDto} zoom="week" onSchedule={onSchedule} canWrite />);
    // parent bar exists AND carries drag handles (a move shifts the subtree)
    expect(screen.getByTestId("fe4-gantt-bar-p")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-gantt-bar-p-rz-l")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-gantt-bar-p-rz-r")).toBeInTheDocument();
  });

  it("zoom SegmentedControl fires onZoomChange and reflects the active granularity", () => {
    const onZoomChange = vi.fn();
    render(<GanttView dto={dto} zoom="month" onZoomChange={onZoomChange} />);
    // the shared SegmentedControl keeps the fe4-gantt-zoom-* testids + tab semantics
    expect(screen.getByTestId("fe4-gantt-zoom-month")).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByTestId("fe4-gantt-zoom-week"));
    expect(onZoomChange).toHaveBeenCalledWith("week");
    expect(screen.getByTestId("fe4-gantt-zoom-week")).toHaveAttribute("aria-selected", "true");
  });

  it("renders the 並び替え selector (all four modes) and fires onSortModeChange", () => {
    const onSortModeChange = vi.fn();
    render(<GanttView dto={dto} zoom="week" sortMode="manual" onSortModeChange={onSortModeChange} />);
    const select = screen.getByTestId("fe4-gantt-sort") as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    expect(select.value).toBe("manual");
    // all four requested modes are offered
    const values = [...select.options].map((o) => o.value);
    expect(values).toEqual(["manual", "priority", "schedule", "team"]);
    fireEvent.change(select, { target: { value: "priority" } });
    expect(onSortModeChange).toHaveBeenCalledWith("priority");
  });

  it("hides the drag handles when an automatic sort is active (only 手動 allows DnD)", () => {
    const onReorder = vi.fn();
    // manual mode → drag handle present
    const { rerender } = render(
      <GanttView dto={dto} zoom="week" canWrite sortMode="manual" onReorder={onReorder} onSortModeChange={vi.fn()} />,
    );
    expect(screen.getByTestId("fe4-gantt-drag-a")).toBeInTheDocument();
    // switch to an automatic sort → handles gone (a re-sort would overwrite the drop)
    rerender(
      <GanttView dto={dto} zoom="week" canWrite sortMode="priority" onReorder={onReorder} onSortModeChange={vi.fn()} />,
    );
    expect(screen.queryByTestId("fe4-gantt-drag-a")).toBeNull();
  });

  it("拡大: enters a look-only fullscreen mode that hides edit affordances, then Esc/閉じる exits", () => {
    const onSchedule = vi.fn();
    const onSelect = vi.fn();
    render(
      <GanttView
        dto={wbsDto}
        zoom="week"
        canWrite
        onSchedule={onSchedule}
        onSelect={onSelect}
        onCreateOnDate={vi.fn()}
        onReorder={vi.fn()}
        sortMode="manual"
        onSortModeChange={vi.fn()}
      />,
    );
    // editing affordances present before 拡大
    expect(screen.getByTestId("fe4-gantt-bar-p-rz-l")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-gantt-addrow")).toBeInTheDocument();
    expect(screen.getByTestId("fe4-gantt-sort")).toBeInTheDocument();
    expect(screen.queryByTestId("fe4-gantt-viewonly-badge")).toBeNull();

    // 拡大 → look-only fullscreen
    fireEvent.click(screen.getByTestId("fe4-gantt-fullscreen-btn"));
    const view = screen.getByTestId("fe4-gantt-view");
    expect(view).toHaveAttribute("data-presenting", "1");
    expect(screen.getByTestId("fe4-gantt-viewonly-badge")).toBeInTheDocument();
    // edit affordances are gone (no resize handles, no add-row, no sort)
    expect(screen.queryByTestId("fe4-gantt-bar-p-rz-l")).toBeNull();
    expect(screen.queryByTestId("fe4-gantt-addrow")).toBeNull();
    expect(screen.queryByTestId("fe4-gantt-sort")).toBeNull();
    // tapping a bar no longer opens detail (pure viewing)
    fireEvent.pointerDown(screen.getByTestId("fe4-gantt-bar-p"));
    fireEvent.pointerUp(screen.getByTestId("fe4-gantt-bar-p"));
    expect(onSelect).not.toHaveBeenCalled();
    // zoom (a viewing operation) still works while presenting
    expect(screen.getByTestId("fe4-gantt-zoom-day")).toBeInTheDocument();

    // Esc exits back to the editable view
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("fe4-gantt-view")).not.toHaveAttribute("data-presenting");
    expect(screen.queryByTestId("fe4-gantt-viewonly-badge")).toBeNull();
    expect(screen.getByTestId("fe4-gantt-bar-p-rz-l")).toBeInTheDocument();
  });
});

describe("ViewSwitcher", () => {
  it("switches active view", () => {
    const onChange = vi.fn();
    render(<ViewSwitcher value="list" onChange={onChange} />);
    fireEvent.click(screen.getByTestId("fe4-view-gantt"));
    expect(onChange).toHaveBeenCalledWith("gantt");
  });
});

describe("TaskListView LoadMore (design test 1)", () => {
  it("renders rows and fires LoadMore only when hasMore", () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(
      <TaskListView tasks={[mk("1"), mk("2")]} users={createUserCache()} hasMore onLoadMore={onLoadMore} onOpen={() => {}} />,
    );
    expect(screen.getByTestId("fe4-task-row-1")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("fe4-load-more"));
    expect(onLoadMore).toHaveBeenCalledOnce();
    rerender(<TaskListView tasks={[mk("1")]} users={createUserCache()} hasMore={false} onLoadMore={onLoadMore} onOpen={() => {}} />);
    expect(screen.queryByTestId("fe4-load-more")).toBeNull();
  });
});

describe("TaskBoardView (design test 10)", () => {
  it("renders all 5 columns; read-only disables cards", () => {
    render(
      <TaskBoardView
        tasksByStatus={(s) => (s === "todo" ? [mk("1")] : [])}
        getTask={() => mk("1")}
        onMove={() => {}}
        canWrite={false}
      />,
    );
    for (const col of ["todo", "in_progress", "blocked", "done", "cancelled"]) {
      expect(screen.getByTestId(`fe4-column-${col}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("fe4-column-todo")).toHaveAttribute("aria-disabled", "true");
  });
});
