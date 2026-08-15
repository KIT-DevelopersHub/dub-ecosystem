import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { gantt, task } from "@dub/types";
import { GanttView } from "../src/components/GanttView";
import { ViewSwitcher } from "../src/components/ViewSwitcher";
import { TaskListView } from "../src/components/TaskListView";
import { TaskBoardView } from "../src/components/TaskBoardView";
import { createUserCache } from "../src/domain/user-cache";

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
    // expanded parent draws its faint enclosing group band
    expect(screen.getByTestId("fe4-gantt-group-p")).toBeInTheDocument();
  });

  it("parent bar is a summary that has no resize handles (rolled-up, not editable)", () => {
    const onSchedule = vi.fn();
    render(<GanttView dto={wbsDto} zoom="week" onSchedule={onSchedule} canWrite />);
    // parent bar exists but exposes no drag handles (children carry the edits)
    expect(screen.getByTestId("fe4-gantt-bar-p")).toBeInTheDocument();
    expect(screen.queryByTestId("fe4-gantt-bar-p-rz-l")).toBeNull();
    expect(screen.queryByTestId("fe4-gantt-bar-p-rz-r")).toBeNull();
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
