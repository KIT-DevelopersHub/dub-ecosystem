// MyDayWidget — verifies the personal home card: live 対応中タスク count, its
// empty/pending/error states, the 未読メンション 空状態, and quick-action navigation.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { MyDayWidget } from "./MyDayWidget.tsx";

describe("MyDayWidget", () => {
  it("shows the live open-task count and links to マイタスク", () => {
    render(<MyDayWidget openTasks={7} isPending={false} taskError={false} />);
    expect(screen.getByTestId("fe2-myday-open-count")).toHaveTextContent("7");
    expect(screen.getByTestId("fe2-myday-open-tasks")).toHaveAttribute("href", "/me/tasks");
  });

  it("renders a skeleton while /bff/home is pending (no empty flash)", () => {
    render(<MyDayWidget openTasks={undefined} isPending taskError={false} />);
    expect(screen.queryByTestId("fe2-myday-tasks-empty")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fe2-myday-open-count")).not.toBeInTheDocument();
  });

  it("shows a tidy empty state when nothing is open", () => {
    render(<MyDayWidget openTasks={0} isPending={false} taskError={false} />);
    expect(screen.getByTestId("fe2-myday-tasks-empty")).toBeInTheDocument();
  });

  it("shows an in-frame hint (not a 0) when task-service degraded", () => {
    render(<MyDayWidget openTasks={undefined} isPending={false} taskError />);
    expect(screen.getByTestId("fe2-myday-tasks-error")).toBeInTheDocument();
    expect(screen.queryByTestId("fe2-myday-open-count")).not.toBeInTheDocument();
  });

  it("always offers the 未読メンション 空状態 (no data source yet)", () => {
    render(<MyDayWidget openTasks={3} isPending={false} taskError={false} />);
    expect(screen.getByTestId("fe2-myday-mentions-empty")).toBeInTheDocument();
  });

  it("navigates via a quick action", async () => {
    const onNavigate = vi.fn();
    render(<MyDayWidget openTasks={3} isPending={false} taskError={false} onNavigate={onNavigate} />);
    await userEvent.click(screen.getByTestId("fe2-myday-action-chat"));
    expect(onNavigate).toHaveBeenCalledWith("/chat");
  });
});
