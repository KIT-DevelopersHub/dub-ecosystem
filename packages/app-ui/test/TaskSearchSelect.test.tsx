import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TaskSearchSelect, rememberTaskSearch } from "../src/index";

const OPTS = [
  { id: "t1", title: "会場予約" },
  { id: "t2", title: "スポンサー募集" },
  { id: "t3", title: "登壇者調整" },
];

beforeEach(() => localStorage.clear());

describe("TaskSearchSelect — single mode (親タスク)", () => {
  it("does not list options up-front; searches by title and picks one", () => {
    const onChange = vi.fn();
    render(<TaskSearchSelect value={null} options={OPTS} onChange={onChange} testId="parent" />);
    expect(screen.queryByTestId("parent-opt-t2")).toBeNull();
    const input = screen.getByTestId("parent-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "スポンサー" } });
    expect(screen.getByTestId("parent-opt-t2")).toBeInTheDocument();
    expect(screen.queryByTestId("parent-opt-t1")).toBeNull(); // filtered out
    fireEvent.mouseDown(screen.getByTestId("parent-opt-t2"));
    expect(onChange).toHaveBeenCalledWith("t2"); // 選択 = 有り (that task)
  });

  it("shows the selected task as a chip; clearing it means 無し (null)", () => {
    const onChange = vi.fn();
    render(<TaskSearchSelect value={"t3"} options={OPTS} onChange={onChange} testId="parent" />);
    expect(screen.getByTestId("parent-chip-t3")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("parent-remove-t3"));
    expect(onChange).toHaveBeenCalledWith(null); // 空 = 無し (親なし)
  });

  it("picking a different task replaces the single value (only one parent)", () => {
    const onChange = vi.fn();
    render(<TaskSearchSelect value={"t1"} options={OPTS} onChange={onChange} testId="parent" />);
    const input = screen.getByTestId("parent-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "登壇" } });
    fireEvent.mouseDown(screen.getByTestId("parent-opt-t3"));
    expect(onChange).toHaveBeenCalledWith("t3"); // replace, not append
  });

  it("renders the empty-value hint", () => {
    render(
      <TaskSearchSelect value={null} options={OPTS} onChange={() => {}} hint="空欄のままなら親なし" testId="parent" />,
    );
    expect(screen.getByText("空欄のままなら親なし")).toBeInTheDocument();
  });
});

describe("TaskSearchSelect — multi mode (先行タスク) + recents", () => {
  it("appends selections and offers a per-chip action", () => {
    const onChange = vi.fn();
    const onAct = vi.fn();
    render(
      <TaskSearchSelect
        multiple
        value={["t1"]}
        options={OPTS}
        onChange={onChange}
        chipAction={{ label: "親に", title: (o) => `${o.title} を親に`, onAct }}
        testId="deps"
      />,
    );
    // existing chip + its action
    fireEvent.click(screen.getByTestId("deps-promote-t1"));
    expect(onAct).toHaveBeenCalledWith("t1");
    // add another (append, keeping t1)
    const input = screen.getByTestId("deps-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "登壇" } });
    fireEvent.mouseDown(screen.getByTestId("deps-opt-t3"));
    expect(onChange).toHaveBeenCalledWith(["t1", "t3"]);
  });

  it("on focus (empty query) suggests only the latest 2 recents", () => {
    // stored order (most-recent first): t3, t2, t1
    rememberTaskSearch("parents", ["t3", "t2", "t1"]);
    render(
      <TaskSearchSelect value={null} options={OPTS} onChange={() => {}} recentKey="parents" testId="p" />,
    );
    fireEvent.focus(screen.getByTestId("p-input"));
    expect(screen.getByText("最近選んだタスク")).toBeInTheDocument();
    // exactly 2 suggestions, the two most-recent — the 3rd (t1) is not shown
    const suggestions = screen.getAllByTestId(/^p-opt-/);
    expect(suggestions).toHaveLength(2);
    expect(screen.getByTestId("p-opt-t3")).toBeInTheDocument();
    expect(screen.getByTestId("p-opt-t2")).toBeInTheDocument();
    expect(screen.queryByTestId("p-opt-t1")).toBeNull();
  });

  it("clicking a recent suggestion selects it", () => {
    const onChange = vi.fn();
    rememberTaskSearch("parents", ["t2"]);
    render(
      <TaskSearchSelect value={null} options={OPTS} onChange={onChange} recentKey="parents" testId="p" />,
    );
    fireEvent.focus(screen.getByTestId("p-input"));
    fireEvent.mouseDown(screen.getByTestId("p-opt-t2"));
    expect(onChange).toHaveBeenCalledWith("t2");
  });

  it("typing switches from recents to search results (history hidden)", () => {
    rememberTaskSearch("parents", ["t3", "t2"]);
    render(
      <TaskSearchSelect value={null} options={OPTS} onChange={() => {}} recentKey="parents" testId="p" />,
    );
    const input = screen.getByTestId("p-input");
    fireEvent.focus(input);
    expect(screen.getByText("最近選んだタスク")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "会場" } }); // t1 = 会場予約
    expect(screen.queryByText("最近選んだタスク")).toBeNull(); // history gone
    expect(screen.getByTestId("p-opt-t1")).toBeInTheDocument(); // search result shown
  });
});
