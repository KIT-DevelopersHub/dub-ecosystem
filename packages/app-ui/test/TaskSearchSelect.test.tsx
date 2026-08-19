import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TaskSearchSelect } from "../src/index";

const OPTS = [
  { id: "t1", title: "会場予約" },
  { id: "t2", title: "スポンサー募集" },
  { id: "t3", title: "登壇者調整" },
];

describe("TaskSearchSelect — single mode (親タスク)", () => {
  it("opens a dropdown of ALL candidates on focus (scroll to choose)", () => {
    render(<TaskSearchSelect value={null} options={OPTS} onChange={() => {}} testId="parent" />);
    // nothing before focus
    expect(screen.queryByTestId("parent-opt-t1")).toBeNull();
    fireEvent.focus(screen.getByTestId("parent-input"));
    // every candidate is listed, no typing required
    expect(screen.getAllByTestId(/^parent-opt-/)).toHaveLength(3);
    expect(screen.getByTestId("parent-opt-t1")).toBeInTheDocument();
    expect(screen.getByTestId("parent-opt-t2")).toBeInTheDocument();
    expect(screen.getByTestId("parent-opt-t3")).toBeInTheDocument();
  });

  it("filters the dropdown by title while typing", () => {
    render(<TaskSearchSelect value={null} options={OPTS} onChange={() => {}} testId="parent" />);
    const input = screen.getByTestId("parent-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "スポンサー" } });
    expect(screen.getByTestId("parent-opt-t2")).toBeInTheDocument();
    expect(screen.queryByTestId("parent-opt-t1")).toBeNull();
    expect(screen.queryByTestId("parent-opt-t3")).toBeNull();
  });

  it("picks a candidate with the mouse", () => {
    const onChange = vi.fn();
    render(<TaskSearchSelect value={null} options={OPTS} onChange={onChange} testId="parent" />);
    fireEvent.focus(screen.getByTestId("parent-input"));
    fireEvent.mouseDown(screen.getByTestId("parent-opt-t2"));
    expect(onChange).toHaveBeenCalledWith("t2");
  });

  it("navigates with ArrowDown/ArrowUp and picks with Enter", () => {
    const onChange = vi.fn();
    render(<TaskSearchSelect value={null} options={OPTS} onChange={onChange} testId="parent" />);
    const input = screen.getByTestId("parent-input");
    fireEvent.focus(input);
    // active starts at index 0 (t1); ↓↓ → t3, then Enter
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("t3");
  });

  it("Enter with a filtered list picks the top match", () => {
    const onChange = vi.fn();
    render(<TaskSearchSelect value={null} options={OPTS} onChange={onChange} testId="parent" />);
    const input = screen.getByTestId("parent-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "登壇" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("t3");
  });

  it("shows the selected task as a chip; clearing it means 無し (null)", () => {
    const onChange = vi.fn();
    render(<TaskSearchSelect value={"t3"} options={OPTS} onChange={onChange} testId="parent" />);
    expect(screen.getByTestId("parent-chip-t3")).toBeInTheDocument();
    // the selected task is not offered again in the list
    fireEvent.focus(screen.getByTestId("parent-input"));
    expect(screen.queryByTestId("parent-opt-t3")).toBeNull();
    fireEvent.click(screen.getByTestId("parent-remove-t3"));
    expect(onChange).toHaveBeenCalledWith(null); // 空 = 無し (親なし)
  });

  it("picking a different task replaces the single value (only one parent)", () => {
    const onChange = vi.fn();
    render(<TaskSearchSelect value={"t1"} options={OPTS} onChange={onChange} testId="parent" />);
    fireEvent.focus(screen.getByTestId("parent-input"));
    fireEvent.mouseDown(screen.getByTestId("parent-opt-t3"));
    expect(onChange).toHaveBeenCalledWith("t3"); // replace, not append
  });

  it("renders the empty-value hint", () => {
    render(
      <TaskSearchSelect value={null} options={OPTS} onChange={() => {}} hint="空欄のままなら親なし" testId="parent" />,
    );
    expect(screen.getByText("空欄のままなら親なし")).toBeInTheDocument();
  });

  it("with no options, disables the input and shows the empty label", () => {
    render(
      <TaskSearchSelect value={null} options={[]} onChange={() => {}} emptyOptionsLabel="親にできるタスクがありません" testId="parent" />,
    );
    const input = screen.getByTestId("parent-input") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe("親にできるタスクがありません");
  });
});

describe("TaskSearchSelect — multi mode (先行タスク)", () => {
  it("lists all not-yet-selected candidates on focus and appends on pick", () => {
    const onChange = vi.fn();
    render(<TaskSearchSelect multiple value={["t1"]} options={OPTS} onChange={onChange} testId="deps" />);
    fireEvent.focus(screen.getByTestId("deps-input"));
    // t1 already selected → only t2, t3 offered
    expect(screen.getAllByTestId(/^deps-opt-/)).toHaveLength(2);
    expect(screen.queryByTestId("deps-opt-t1")).toBeNull();
    fireEvent.mouseDown(screen.getByTestId("deps-opt-t3"));
    expect(onChange).toHaveBeenCalledWith(["t1", "t3"]); // append, keep t1
  });

  it("offers a per-chip action", () => {
    const onAct = vi.fn();
    render(
      <TaskSearchSelect
        multiple
        value={["t1"]}
        options={OPTS}
        onChange={() => {}}
        chipAction={{ label: "親に", title: (o) => `${o.title} を親に`, onAct }}
        testId="deps"
      />,
    );
    fireEvent.click(screen.getByTestId("deps-promote-t1"));
    expect(onAct).toHaveBeenCalledWith("t1");
  });
});
