import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { task } from "@dub/types";
import { PredecessorPicker } from "../src/components/PredecessorPicker";
import { DateField } from "../src/components/DateField";
import { TaskDetailPanel } from "../src/components/TaskDetailPanel";

const OPTS = [
  { id: "t1", title: "会場予約" },
  { id: "t2", title: "スポンサー募集" },
  { id: "t3", title: "登壇者調整" },
];

describe("PredecessorPicker — scrollable dropdown + search (feature #1)", () => {
  it("lists ALL candidates on focus, and narrows them while typing", () => {
    render(<PredecessorPicker options={OPTS} value={[]} onChange={() => {}} testId="pp" />);
    expect(screen.queryByTestId("pp-opt-t1")).toBeNull(); // nothing before focus
    const input = screen.getByTestId("pp-input");
    fireEvent.focus(input);
    expect(screen.getAllByTestId(/^pp-opt-/)).toHaveLength(3); // full list, no typing
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

  it("supports keyboard selection (↓ then Enter)", () => {
    const onChange = vi.fn();
    render(<PredecessorPicker options={OPTS} value={[]} onChange={onChange} testId="pp" />);
    const input = screen.getByTestId("pp-input");
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" }); // index 0 -> 1 (t2)
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["t2"]);
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
