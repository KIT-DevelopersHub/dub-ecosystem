import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { task } from "@dub/types";
import { PredecessorPicker, rememberPredecessors } from "../src/components/PredecessorPicker";
import { DateField } from "../src/components/DateField";
import { TaskDetailPanel } from "../src/components/TaskDetailPanel";

const OPTS = [
  { id: "t1", title: "会場予約" },
  { id: "t2", title: "スポンサー募集" },
  { id: "t3", title: "登壇者調整" },
];

beforeEach(() => localStorage.clear());

describe("PredecessorPicker — searchable combobox (feature #1)", () => {
  it("does not list all tasks up-front; searches by title", () => {
    render(<PredecessorPicker options={OPTS} value={[]} onChange={() => {}} testId="pp" />);
    // no option is shown until the user focuses + types (no giant flat list)
    expect(screen.queryByTestId("pp-opt-t1")).toBeNull();
    const input = screen.getByTestId("pp-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "スポンサー" } });
    expect(screen.getByTestId("pp-opt-t2")).toBeInTheDocument();
    expect(screen.queryByTestId("pp-opt-t1")).toBeNull(); // filtered out
  });

  it("selecting a match calls onChange and shows a removable chip", () => {
    const onChange = vi.fn();
    const { rerender } = render(<PredecessorPicker options={OPTS} value={[]} onChange={onChange} testId="pp" />);
    const input = screen.getByTestId("pp-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "登壇" } });
    fireEvent.mouseDown(screen.getByTestId("pp-opt-t3"));
    expect(onChange).toHaveBeenCalledWith(["t3"]);
    rerender(<PredecessorPicker options={OPTS} value={["t3"]} onChange={onChange} testId="pp" />);
    expect(screen.getByTestId("pp-chip-t3")).toBeInTheDocument();
  });

  it("surfaces the latest 2 recently-chosen tasks when the query is empty", () => {
    rememberPredecessors(["t3", "t2", "t1"]); // stored most-recent first
    render(<PredecessorPicker options={OPTS} value={[]} onChange={() => {}} testId="pp" />);
    fireEvent.focus(screen.getByTestId("pp-input"));
    expect(screen.getByText("最近選んだタスク")).toBeInTheDocument();
    // exactly 2 suggestions (the 3rd, t1, is dropped)
    expect(screen.getAllByTestId(/^pp-opt-/)).toHaveLength(2);
    expect(screen.getByTestId("pp-opt-t3")).toBeInTheDocument();
    expect(screen.getByTestId("pp-opt-t2")).toBeInTheDocument();
    expect(screen.queryByTestId("pp-opt-t1")).toBeNull();
  });

  it("rememberPredecessors dedupes and caps recent history", () => {
    rememberPredecessors(["a", "b"]);
    rememberPredecessors(["b", "c"]);
    const raw = JSON.parse(localStorage.getItem("fe4:recent-predecessors")!);
    expect(raw[0]).toBe("b"); // most-recent first
    expect(new Set(raw).size).toBe(raw.length); // no dups
  });
});

describe("DateField — styled calendar (feature #3, no native UI)", () => {
  it("shows a placeholder trigger and hides the native input off-screen", () => {
    render(<DateField value={null} onChange={() => {}} testId="df" />);
    expect(screen.getByText("日付を選択")).toBeInTheDocument();
    const native = screen.getByTestId("df") as HTMLInputElement;
    expect(native.type).toBe("date");
    expect(native).toHaveAttribute("aria-hidden", "true"); // not shown to the user
  });

  it("opens the calendar and picking a day emits yyyy-mm-dd", () => {
    const onChange = vi.fn();
    render(<DateField value={null} onChange={onChange} testId="df" />);
    fireEvent.click(screen.getByTestId("df-trigger"));
    fireEvent.click(screen.getByTestId("df-day-15"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(String(onChange.mock.calls[0]?.[0])).toMatch(/^\d{4}-\d{2}-15$/);
  });
});

const mkTask = (id: string): task.Task => ({
  id, eventId: "evt_1", title: "親タスク", description: null, status: "todo",
  priority: "medium", assigneeId: null, dueAt: "2026-08-20T00:00:00Z", origin: "internal",
  archivedAt: null, createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", version: 1,
});

describe("TaskDetailPanel — create child task (feature #4)", () => {
  it("renders the child-create action and passes this task id as the parent", () => {
    const onCreateChild = vi.fn();
    render(
      <TaskDetailPanel
        task={mkTask("parent1")}
        users={[]}
        canWrite
        canDelete
        onSave={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
        onCreateChild={onCreateChild}
      />,
    );
    const btn = screen.getByTestId("fe4-detail-create-child");
    expect(within(btn).getByText(/子タスクを作成/)).toBeInTheDocument();
    fireEvent.click(btn);
    expect(onCreateChild).toHaveBeenCalledWith("parent1");
  });
});
