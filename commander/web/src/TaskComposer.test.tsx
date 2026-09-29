import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskComposer } from "./TaskComposer.tsx";

describe("<TaskComposer>", () => {
  it("keeps in-progress input when a poll rebuilds cwdSuggestions (regression)", async () => {
    // The board rebuilds cwdSuggestions into a fresh array on every poll tick. The reset
    // effect must NOT refire on that identity change, or typed input is wiped mid-entry.
    const { rerender } = render(
      <TaskComposer open onClose={() => {}} onSubmit={() => {}} cwdSuggestions={["/repo/a"]} />,
    );

    await userEvent.type(screen.getByLabelText("task-title"), "入力中のタスク");
    await userEvent.type(screen.getByLabelText("task-prompt"), "消えないでほしい");

    // Simulate a poll: same content, brand-new array reference (as useMemo produces).
    rerender(
      <TaskComposer open onClose={() => {}} onSubmit={() => {}} cwdSuggestions={["/repo/a"]} />,
    );

    expect(screen.getByLabelText("task-title")).toHaveValue("入力中のタスク");
    expect(screen.getByLabelText("task-prompt")).toHaveValue("消えないでほしい");
  });

  it("resets fields when the drawer is reopened", async () => {
    const { rerender } = render(
      <TaskComposer open onClose={() => {}} onSubmit={() => {}} cwdSuggestions={[]} />,
    );
    await userEvent.type(screen.getByLabelText("task-title"), "前回の入力");
    expect(screen.getByLabelText("task-title")).toHaveValue("前回の入力");

    rerender(<TaskComposer open={false} onClose={() => {}} onSubmit={() => {}} cwdSuggestions={[]} />);
    rerender(<TaskComposer open onClose={() => {}} onSubmit={() => {}} cwdSuggestions={["/repo/x"]} />);

    expect(screen.getByLabelText("task-title")).toHaveValue("");
    // cwd is seeded from the latest suggestions on (re)open.
    expect(screen.getByLabelText("task-cwd")).toHaveValue("/repo/x");
  });

  it("submits the trimmed field values", async () => {
    const onSubmit = vi.fn();
    render(<TaskComposer open onClose={() => {}} onSubmit={onSubmit} cwdSuggestions={[]} />);

    await userEvent.type(screen.getByLabelText("task-title"), "  作る  ");
    await userEvent.type(screen.getByLabelText("task-prompt"), " やって ");
    await userEvent.click(screen.getByTestId("composer-submit"));

    expect(onSubmit).toHaveBeenCalledWith({ title: "作る", cwd: "", prompt: "やって", ledgerRef: "" });
  });
});
