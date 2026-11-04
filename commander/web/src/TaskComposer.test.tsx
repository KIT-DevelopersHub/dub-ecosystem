import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskComposer } from "./TaskComposer.tsx";

describe("<TaskComposer>", () => {
  it("keeps in-progress input when the board re-renders it (regression)", async () => {
    // The board re-renders on every poll tick. The reset effect must NOT refire on that,
    // or typed input is wiped mid-entry.
    const { rerender } = render(
      <TaskComposer open onClose={() => {}} onSubmit={() => {}} />,
    );

    await userEvent.type(screen.getByLabelText("task-title"), "入力中のタスク");
    await userEvent.type(screen.getByLabelText("task-prompt"), "消えないでほしい");

    // Simulate a poll re-render.
    rerender(
      <TaskComposer open onClose={() => {}} onSubmit={() => {}} />,
    );

    expect(screen.getByLabelText("task-title")).toHaveValue("入力中のタスク");
    expect(screen.getByLabelText("task-prompt")).toHaveValue("消えないでほしい");
  });

  it("resets fields when the drawer is reopened", async () => {
    const { rerender } = render(
      <TaskComposer open onClose={() => {}} onSubmit={() => {}} />,
    );
    await userEvent.type(screen.getByLabelText("task-title"), "前回の入力");
    expect(screen.getByLabelText("task-title")).toHaveValue("前回の入力");

    rerender(<TaskComposer open={false} onClose={() => {}} onSubmit={() => {}} />);
    rerender(<TaskComposer open onClose={() => {}} onSubmit={() => {}} />);

    expect(screen.getByLabelText("task-title")).toHaveValue("");
  });

  it("has no cwd field: every task gets its own worktree (never another task's)", () => {
    render(<TaskComposer open onClose={() => {}} onSubmit={() => {}} />);
    expect(screen.queryByLabelText("task-cwd")).not.toBeInTheDocument();
    expect(screen.getByTestId("composer-workspace-note")).toHaveTextContent("タスクごと");
  });

  it("submits the trimmed field values", async () => {
    const onSubmit = vi.fn();
    render(<TaskComposer open onClose={() => {}} onSubmit={onSubmit} />);

    await userEvent.type(screen.getByLabelText("task-title"), "  作る  ");
    await userEvent.type(screen.getByLabelText("task-prompt"), " やって ");
    await userEvent.click(screen.getByTestId("composer-submit"));

    expect(onSubmit).toHaveBeenCalledWith({ title: "作る", prompt: "やって", ledgerRef: "", images: [] });
  });
});
